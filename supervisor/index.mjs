#!/usr/bin/env node

import { Telegraf } from 'telegraf';
import { execSync, execFileSync } from 'node:child_process';

// --- Config ---
const BOT_TOKEN = process.env.SUPERVISOR_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('SUPERVISOR_BOT_TOKEN env var required');
  process.exit(1);
}

const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USERS || '').split(',').filter(Boolean).map(Number)
);
const START_CMD = process.env.START_CMD || './start.sh';
const WATCHDOG_INTERVAL = parseInt(process.env.WATCHDOG_INTERVAL ?? '60');
const MAX_CONSECUTIVE_RESTARTS = parseInt(
  process.env.MAX_CONSECUTIVE_RESTARTS ?? '5'
);
const BOOT_DELAY = parseInt(process.env.BOOT_DELAY || '10');
const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL || '0');
const MONITOR_CAPTURE_LINES = parseInt(
  process.env.MONITOR_CAPTURE_LINES || '500'
);
// Context check: kill + restart when Claude's context usage exceeds threshold.
// Indicator parsed from TUI is "Context left until auto-compact: X%".
const CONTEXT_CHECK_INTERVAL = parseInt(
  process.env.CONTEXT_CHECK_INTERVAL ?? '86400'
);
const CONTEXT_THRESHOLD = parseInt(process.env.CONTEXT_THRESHOLD ?? '50');
// How long to reuse a /context result before re-querying. Running /context
// adds a line to the bot's TUI history, so we don't want to hit it on every
// /status call. Daily context-check uses the same cache with a 24h interval,
// so it always forces a fresh query naturally.
const CONTEXT_CACHE_SECONDS = parseInt(
  process.env.CONTEXT_CACHE_SECONDS ?? '300'
);
// How long to wait after sending `/context` for Claude's TUI to finish
// rendering the usage block. /context takes a few seconds in practice.
const CONTEXT_QUERY_WAIT_MS = parseInt(
  process.env.CONTEXT_QUERY_WAIT_MS ?? '4000'
);
// Grace window after a deliberate restart: watchdog skips the bot so the
// in-flight boot doesn't get mistaken for a crash.
const RESTART_GRACE_SECONDS = 30;

// Parse BOTS: "name:session:dir,name2:session2:dir2"
// Falls back to legacy single-bot env vars
function parseBots() {
  const botsEnv = process.env.BOTS || '';
  if (botsEnv) {
    return botsEnv.split(',').map((entry) => {
      const [name, session, workDir] = entry.split(':');
      return { name, session, target: session, workDir };
    });
  }
  // Legacy single-bot fallback
  const session = process.env.TMUX_SESSION || 'bot';
  const workDir = process.env.WORK_DIR || process.cwd();
  return [{ name: session, session, target: session, workDir }];
}

const BOTS = parseBots();
const botsByName = new Map(BOTS.map((b) => [b.name, b]));

function getBot(name) {
  if (!name && BOTS.length === 1) return BOTS[0];
  return botsByName.get(name) || null;
}

// --- Helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf-8', timeout: 10_000 }).trim();
}

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '');
}

// --- tmux operations (per bot) ---
function sessionExists(bot) {
  try {
    sh(`tmux has-session -t ${bot.session} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function ensureSession(bot) {
  if (!sessionExists(bot)) {
    sh(`tmux new-session -d -s ${bot.session} -c ${bot.workDir}`);
  }
}

function getPanePid(bot) {
  try {
    return parseInt(
      sh(`tmux display-message -t ${bot.target} -p '#{pane_pid}'`)
    );
  } catch {
    return null;
  }
}

// Linux exposes /proc/<pid>/cmdline; macOS does not. Try the platform-native
// path first, fall back to `ps` the other way. Returned string may be a bare
// name (`claude ...`) or path-prefixed (`/usr/local/bin/claude ...`) depending
// on how the process was launched — downstream matchers must handle both.
function getProcCmd(pid) {
  const tryProc = () => {
    try {
      const cmd = sh(`cat /proc/${pid}/cmdline 2>/dev/null`);
      if (cmd) return cmd;
    } catch {
      /* not available */
    }
    return null;
  };
  const tryPs = () => {
    try {
      const cmd = sh(`ps -p ${pid} -o command= 2>/dev/null`).trim();
      if (cmd) return cmd;
    } catch {
      /* no such pid */
    }
    return null;
  };
  if (process.platform === 'linux') {
    return tryProc() ?? tryPs() ?? '';
  }
  return tryPs() ?? tryProc() ?? '';
}

function isClaudeCmd(cmd) {
  return /(?:^|\/)claude(?:$|\s|\0)/.test(cmd);
}

function getClaudePid(bot) {
  const panePid = getPanePid(bot);
  if (!panePid) return null;
  try {
    const children = sh(`pgrep -P ${panePid}`)
      .split('\n')
      .filter(Boolean)
      .map(Number);
    for (const pid of children) {
      try {
        if (isClaudeCmd(getProcCmd(pid))) return pid;
        const grandchildren = sh(`pgrep -P ${pid}`)
          .split('\n')
          .filter(Boolean)
          .map(Number);
        for (const gc of grandchildren) {
          if (isClaudeCmd(getProcCmd(gc))) return gc;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no children */
  }
  return null;
}

function isRunning(bot) {
  return getClaudePid(bot) !== null;
}

async function killProcess(bot) {
  const panePid = getPanePid(bot);
  if (!panePid) return false;

  let children;
  try {
    children = sh(`pgrep -P ${panePid}`)
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return false;
  }
  if (!children.length) return false;

  for (const p of children) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {
      /* already dead */
    }
  }

  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (!isRunning(bot)) return true;
  }

  for (const p of children) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
  await sleep(500);
  return true;
}

function startProcess(bot) {
  ensureSession(bot);
  sh(
    `tmux send-keys -t ${bot.target} 'cd ${bot.workDir} && ${START_CMD}' Enter`
  );
  setTimeout(() => {
    try {
      execFileSync('tmux', ['send-keys', '-t', bot.target, '-l', 'start'], {
        timeout: 10_000,
      });
      execFileSync('tmux', ['send-keys', '-t', bot.target, 'Enter'], {
        timeout: 10_000,
      });
    } catch {
      /* session may not be ready */
    }
  }, BOOT_DELAY * 1000);
}

function capturePane(bot, lines = 50) {
  try {
    return stripAnsi(
      sh(`tmux capture-pane -t ${bot.target} -p -S -${lines}`)
    );
  } catch {
    return null;
  }
}

// Line-level diff: return lines present in `current` that weren't in `prev`.
// Prefix/substring matching breaks because the TUI's bottom chrome (input box,
// status line with live time) mutates slightly between captures and middle
// content grows in-place — there's no single stable anchor. Set-diff on lines
// filters stable chrome and reports only additions, in original order.
function extractNewContent(prev, current) {
  if (!prev || !current) return null;
  if (prev === current) return null;
  const prevSet = new Set(prev.split('\n').map((l) => l.trimEnd()));
  const additions = [];
  for (const raw of current.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (prevSet.has(line)) continue;
    additions.push(line);
  }
  if (additions.length === 0) return null;
  return additions.join('\n');
}

// --- Parse bot name from command args ---
function parseBotArg(ctx) {
  const text = ctx.message.text;
  const parts = text.split(/\s+/).slice(1);
  const name = parts[0];
  if (name) {
    const bot = getBot(name);
    if (!bot) {
      ctx.reply(
        `Unknown bot: ${name}\nAvailable: ${BOTS.map((b) => b.name).join(', ')}`
      );
      return null;
    }
    return bot;
  }
  if (BOTS.length === 1) return BOTS[0];
  ctx.reply(
    `Multiple bots configured. Specify which one:\n${BOTS.map((b) => `  ${b.name}`).join('\n')}\n\nExample: /status ${BOTS[0].name}`
  );
  return null;
}

// --- Telegram Bot ---
const tg = new Telegraf(BOT_TOKEN);

tg.use((ctx, next) => {
  if (ALLOWED_USERS.size && !ALLOWED_USERS.has(ctx.from?.id)) return;
  return next();
});

tg.command('restart', async (ctx) => {
  const bot = parseBotArg(ctx);
  if (!bot) return;
  const msg = await ctx.reply(`Restarting ${bot.name}...`);
  await killProcess(bot);
  startProcess(bot);
  markRestart(bot.name);
  resetRestartState(bot.name);
  invalidateContextCache(bot.name);
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    msg.message_id,
    null,
    `${bot.name} restarted`
  );
});

tg.command('stop', async (ctx) => {
  const bot = parseBotArg(ctx);
  if (!bot) return;
  if (!isRunning(bot)) return ctx.reply(`${bot.name} not running`);
  await killProcess(bot);
  resetRestartState(bot.name);
  invalidateContextCache(bot.name);
  await ctx.reply(`${bot.name} stopped`);
});

tg.command('start', async (ctx) => {
  const bot = parseBotArg(ctx);
  if (!bot) return;
  if (isRunning(bot)) return ctx.reply(`${bot.name} already running`);
  startProcess(bot);
  markRestart(bot.name);
  resetRestartState(bot.name);
  invalidateContextCache(bot.name);
  await ctx.reply(`${bot.name} started`);
});

tg.command('status', async (ctx) => {
  // No arg + multiple bots → show all
  const text = ctx.message.text;
  const arg = text.split(/\s+/)[1];

  if (!arg && BOTS.length > 1) {
    const lines = await Promise.all(BOTS.map((b) => formatStatusLine(b)));
    return ctx.replyWithHTML(lines.join('\n\n'));
  }

  const bot = parseBotArg(ctx);
  if (!bot) return;
  await ctx.replyWithHTML(await formatStatusLine(bot));
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

async function formatContextLine(bot) {
  const usage = await getContextUsage(bot);
  if (!usage) return '<i>context: query failed</i>';
  const age = Math.round((Date.now() - usage.at) / 1000);
  const tokens = `${formatTokens(usage.tokens)} / ${formatTokens(usage.limit)}`;
  const model = usage.model
    ? `\nmodel: <code>${escapeHtml(usage.model)}</code>`
    : '';
  return (
    `context: <b>${tokens}</b> (${usage.pct}%) <i>· ${age}s ago · restart &gt;${CONTEXT_THRESHOLD}%</i>` +
    model
  );
}

async function formatStatusLine(bot) {
  const claudePid = getClaudePid(bot);
  const header = claudePid
    ? `<b>${escapeHtml(bot.name)}</b> — running`
    : `<b>${escapeHtml(bot.name)}</b> — <b>stopped</b>`;
  const parts = [header];
  if (claudePid) parts.push(`pid: <code>${claudePid}</code>`);
  if (!sessionExists(bot)) parts.push('<i>tmux session not found</i>');
  const state = getRestartState(bot.name);
  if (state.abandoned) {
    parts.push(
      `<i>auto-restart disabled (${MAX_CONSECUTIVE_RESTARTS} failures) — /start ${escapeHtml(bot.name)} to re-enable</i>`
    );
  } else if (state.failures > 0) {
    parts.push(
      `<i>recent restarts: ${state.failures}/${MAX_CONSECUTIVE_RESTARTS}</i>`
    );
  }
  if (claudePid) parts.push(await formatContextLine(bot));
  return parts.join('\n');
}

tg.command('logs', async (ctx) => {
  const bot = parseBotArg(ctx);
  if (!bot) return;
  const content = capturePane(bot, 80);
  if (!content?.trim()) return ctx.reply('No logs');
  const text = content.length > 4000 ? '...' + content.slice(-4000) : content;
  await ctx.reply(text);
});

tg.command('screen', async (ctx) => {
  const bot = parseBotArg(ctx);
  if (!bot) return;
  const content = capturePane(bot, 30);
  if (!content?.trim()) return ctx.reply('No screen');
  await ctx.reply(content);
});

tg.command('send', async (ctx) => {
  // /send <bot> <text>  or  /send <text> (single bot)
  const parts = ctx.message.text.replace(/^\/send\s*/, '');
  let bot, text;
  if (BOTS.length > 1) {
    const firstWord = parts.split(/\s+/)[0];
    bot = getBot(firstWord);
    text = bot ? parts.slice(firstWord.length).trim() : null;
    if (!bot) {
      return ctx.reply(
        `Specify bot: /send <bot> <text>\nAvailable: ${BOTS.map((b) => b.name).join(', ')}`
      );
    }
  } else {
    bot = BOTS[0];
    text = parts;
  }
  if (!text) return ctx.reply('Usage: /send <text>');
  execFileSync('tmux', ['send-keys', '-t', bot.target, '-l', text], {
    timeout: 10_000,
  });
  execFileSync('tmux', ['send-keys', '-t', bot.target, 'Enter'], {
    timeout: 10_000,
  });
  await ctx.reply('Sent');
});

tg.command('monitor', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const action = (parts[0] || 'status').toLowerCase();

  if (action === 'status') {
    if (monitors.size === 0) {
      return ctx.reply('Monitor: off\nUsage: /monitor on [bot] [seconds]');
    }
    const lines = [...monitors.entries()].map(
      ([name, { seconds }]) => `${name}: every ${seconds}s`
    );
    return ctx.reply('Monitor:\n' + lines.join('\n'));
  }

  if (action !== 'on' && action !== 'off') {
    return ctx.reply('Usage: /monitor [on|off|status] [bot] [seconds]');
  }

  let bot;
  let seconds;
  const maybeBot = parts[1];
  if (maybeBot && getBot(maybeBot)) {
    bot = getBot(maybeBot);
    if (action === 'on' && parts[2]) seconds = parseInt(parts[2]);
  } else if (maybeBot && /^\d+$/.test(maybeBot) && BOTS.length === 1) {
    bot = BOTS[0];
    if (action === 'on') seconds = parseInt(maybeBot);
  } else if (!maybeBot && BOTS.length === 1) {
    bot = BOTS[0];
  } else {
    return ctx.reply(
      `Specify bot: /monitor ${action} <bot>${action === 'on' ? ' [seconds]' : ''}\nAvailable: ${BOTS.map((b) => b.name).join(', ')}`
    );
  }

  if (action === 'on') {
    const interval =
      Number.isFinite(seconds) && seconds >= 5
        ? seconds
        : DEFAULT_MONITOR_SECONDS;
    startMonitor(bot, interval);
    return ctx.reply(`Monitoring ${bot.name} every ${interval}s`);
  }

  if (stopMonitor(bot)) {
    return ctx.reply(`Stopped monitoring ${bot.name}`);
  }
  return ctx.reply(`${bot.name} was not being monitored`);
});

tg.command('help', (ctx) => {
  const botHint =
    BOTS.length > 1
      ? `\n\nBots: ${BOTS.map((b) => b.name).join(', ')}\nAdd bot name after command, e.g. /status ${BOTS[0].name}`
      : '';
  ctx.reply(
    '/status - Status, restart counter, context usage\n' +
      '/restart - Restart bot\n' +
      '/stop - Stop bot\n' +
      '/start - Start bot (re-enables auto-restart)\n' +
      '/logs - Recent logs (80 lines)\n' +
      '/screen - Current screen\n' +
      '/send <text> - Type into TUI\n' +
      '/monitor [on|off|status] [bot] [seconds] - Push new pane output\n' +
      '/help - This message' +
      botHint
  );
});

tg.on('text', (ctx) => ctx.reply('Send /help for available commands'));

// --- Watchdog ---
// State: consecutive failed restart attempts per bot. After
// MAX_CONSECUTIVE_RESTARTS, we stop auto-restarting and tell the user to
// investigate. Manual /start or /restart clears the state.
const restartState = new Map(); // botName → { failures, abandoned }
const lastRestartAt = new Map();

function getRestartState(name) {
  let s = restartState.get(name);
  if (!s) {
    s = { failures: 0, abandoned: false };
    restartState.set(name, s);
  }
  return s;
}

function resetRestartState(name) {
  const s = getRestartState(name);
  s.failures = 0;
  s.abandoned = false;
}

function markRestart(name) {
  lastRestartAt.set(name, Date.now());
}

function inRestartGrace(name) {
  const t = lastRestartAt.get(name);
  return t && Date.now() - t < RESTART_GRACE_SECONDS * 1000;
}

if (WATCHDOG_INTERVAL > 0) {
  setInterval(() => {
    for (const bot of BOTS) {
      if (inRestartGrace(bot.name)) continue;
      if (!sessionExists(bot)) continue;

      const state = getRestartState(bot.name);

      if (isRunning(bot)) {
        if (state.failures > 0) state.failures = 0;
        continue;
      }

      if (state.abandoned) continue;

      if (state.failures >= MAX_CONSECUTIVE_RESTARTS) {
        state.abandoned = true;
        console.log(
          `[watchdog] ${bot.name} dead after ${MAX_CONSECUTIVE_RESTARTS} attempts — giving up`
        );
        pushToUsers(
          `⚠️ ${bot.name} crashed ${MAX_CONSECUTIVE_RESTARTS} times in a row. Auto-restart disabled. Investigate, then /start ${bot.name} to re-enable.`
        );
        continue;
      }

      state.failures += 1;
      console.log(
        `[watchdog] ${bot.name} died, restarting (${state.failures}/${MAX_CONSECUTIVE_RESTARTS})`
      );
      startProcess(bot);
      markRestart(bot.name);
      invalidateContextCache(bot.name);
      pushToUsers(
        `${bot.name} crashed — auto-restarted (${state.failures}/${MAX_CONSECUTIVE_RESTARTS})`
      );
    }
  }, WATCHDOG_INTERVAL * 1000);
  console.log(
    `Watchdog enabled, interval: ${WATCHDOG_INTERVAL}s, max restarts: ${MAX_CONSECUTIVE_RESTARTS}`
  );
}

// --- Context usage ---
// We inject `/context` into the bot's TUI and parse Claude Code's own
// breakdown (e.g. `39.3k/1m tokens (4%)`). This is authoritative — Claude
// reports the true model-specific limit, which the session JSONL's `model`
// field strips (e.g. `claude-opus-4-7[1m]` is logged as `claude-opus-4-7`),
// so any JSONL-based computation has no way to tell 200K apart from 1M.
//
// Side effect: each query adds a `/context` line to the bot's TUI history.
// We cache results for CONTEXT_CACHE_SECONDS to avoid spamming the pane on
// every /status call.
const contextCache = new Map(); // botName → { pct, tokens, limit, model, at }

function parseTokenCount(val, suffix) {
  const n = parseFloat(val);
  const s = (suffix || '').toLowerCase();
  if (s === 'k') return Math.round(n * 1000);
  if (s === 'm') return Math.round(n * 1_000_000);
  return Math.round(n);
}

async function queryContext(bot) {
  try {
    execFileSync('tmux', ['send-keys', '-t', bot.target, '-l', '/context'], {
      timeout: 10_000,
    });
    execFileSync('tmux', ['send-keys', '-t', bot.target, 'Enter'], {
      timeout: 10_000,
    });
  } catch {
    return null;
  }
  await sleep(CONTEXT_QUERY_WAIT_MS);
  const pane = capturePane(bot, MONITOR_CAPTURE_LINES);
  if (!pane) return null;
  const m = pane.match(
    /(\d+(?:\.\d+)?)([kmKM]?)\s*\/\s*(\d+(?:\.\d+)?)([kmKM]?)\s+tokens\s*\((\d+(?:\.\d+)?)%\)/
  );
  if (!m) return null;
  const tokens = parseTokenCount(m[1], m[2]);
  const limit = parseTokenCount(m[3], m[4]);
  const pct = parseFloat(m[5]);
  // Scoped to known Claude model families so we don't accidentally match
  // unrelated `claude-*` strings that appear in the pane (e.g. plugin names
  // like `claude-plugins-official`). Update this list when new families ship.
  const modelMatch = pane.match(
    /claude-(?:opus|sonnet|haiku)-[\d][\w.-]*(?:\[[0-9a-z]+\])?/i
  );
  return {
    tokens,
    limit,
    pct,
    model: modelMatch ? modelMatch[0] : null,
    at: Date.now(),
  };
}

async function getContextUsage(bot, { force = false } = {}) {
  if (!force) {
    const cached = contextCache.get(bot.name);
    if (cached && Date.now() - cached.at < CONTEXT_CACHE_SECONDS * 1000) {
      return cached;
    }
  }
  const result = await queryContext(bot);
  if (!result) return contextCache.get(bot.name) || null;
  contextCache.set(bot.name, result);
  return result;
}

function invalidateContextCache(botName) {
  contextCache.delete(botName);
}

if (CONTEXT_CHECK_INTERVAL > 0) {
  setInterval(async () => {
    for (const bot of BOTS) {
      if (inRestartGrace(bot.name)) continue;
      if (!isRunning(bot)) continue;
      const usage = await getContextUsage(bot, { force: true });
      if (!usage) {
        console.log(`[context] ${bot.name}: query failed, skipping`);
        continue;
      }
      console.log(
        `[context] ${bot.name}: ${usage.pct}% used (${usage.tokens}/${usage.limit})`
      );
      if (usage.pct > CONTEXT_THRESHOLD) {
        pushToUsers(
          `${bot.name} context at ${usage.pct}% — restarting for fresh session`
        );
        await killProcess(bot);
        startProcess(bot);
        markRestart(bot.name);
        invalidateContextCache(bot.name);
        resetRestartState(bot.name);
      }
    }
  }, CONTEXT_CHECK_INTERVAL * 1000);
  console.log(
    `Context check enabled, interval: ${CONTEXT_CHECK_INTERVAL}s, threshold: >${CONTEXT_THRESHOLD}%`
  );
}

// --- Monitor: push new tmux pane output to Telegram on an interval ---
// Activated per-bot via the /monitor command; not auto-started.
const lastCaptures = new Map();
const monitors = new Map(); // botName → { intervalId, seconds }
const DEFAULT_MONITOR_SECONDS = MONITOR_INTERVAL > 0 ? MONITOR_INTERVAL : 30;

function pushToUsers(text) {
  for (const uid of ALLOWED_USERS) {
    tg.telegram.sendMessage(uid, text).catch(() => {});
  }
}

function monitorTick(bot) {
  if (!isRunning(bot)) return;
  const current = capturePane(bot, MONITOR_CAPTURE_LINES);
  if (!current) return;
  const prev = lastCaptures.get(bot.name);
  lastCaptures.set(bot.name, current);
  const diff = extractNewContent(prev, current);
  if (!diff) return;
  const body = diff.length > 3500 ? '...' + diff.slice(-3500) : diff;
  const prefix = BOTS.length > 1 ? `[${bot.name}]\n` : '';
  pushToUsers(prefix + body);
}

function startMonitor(bot, seconds) {
  stopMonitor(bot);
  // Seed baseline so the first tick doesn't dump the whole screen as "new".
  const initial = capturePane(bot, MONITOR_CAPTURE_LINES);
  if (initial) lastCaptures.set(bot.name, initial);
  const intervalId = setInterval(() => monitorTick(bot), seconds * 1000);
  monitors.set(bot.name, { intervalId, seconds });
}

function stopMonitor(bot) {
  const entry = monitors.get(bot.name);
  if (!entry) return false;
  clearInterval(entry.intervalId);
  monitors.delete(bot.name);
  lastCaptures.delete(bot.name);
  return true;
}

// --- Command menu (makes `/` autocomplete work in Telegram) ---
const COMMAND_MENU = [
  { command: 'status', description: 'Status, restart counter, context usage' },
  { command: 'restart', description: 'Restart bot' },
  { command: 'start', description: 'Start bot' },
  { command: 'stop', description: 'Stop bot' },
  { command: 'logs', description: 'Recent logs (80 lines)' },
  { command: 'screen', description: 'Current screen' },
  { command: 'send', description: 'Type text into the bot TUI' },
  { command: 'monitor', description: 'Toggle periodic pane-diff push' },
  { command: 'help', description: 'Show help' },
];

// --- Launch ---
tg.launch();
tg.telegram
  .setMyCommands(COMMAND_MENU)
  .catch((err) => console.error('setMyCommands failed:', err.message));
console.log(
  `Supervisor started | bots: ${BOTS.map((b) => `${b.name}@${b.target}`).join(', ')}`
);

process.once('SIGINT', () => tg.stop('SIGINT'));
process.once('SIGTERM', () => tg.stop('SIGTERM'));
