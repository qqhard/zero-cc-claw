#!/usr/bin/env node

import { Telegraf } from 'telegraf';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

// Sleep + restart are now both supervisor-driven instead of bot-owned crons,
// so they keep working when the host boots late — the bot's own CronCreate
// wouldn't have fired if the box was off at the scheduled time, but the
// supervisor sees "past target, not fired today" on the next tick and
// catches up.
//
// Sleep: types SLEEP_COMMAND into the bot's TUI at SLEEP_AT (local HH:MM).
// Default 01:00 matches the typical "user is asleep" window. The command is
// the same plain-text prompt the bot's old CronCreate used so no new slash
// command is needed — also instructs the bot to read yesterday's journal in
// case sleep is running late (catch-up path).
const SLEEP_AT = process.env.SLEEP_AT ?? '01:00';
const SLEEP_COMMAND =
  process.env.SLEEP_COMMAND ||
  '读取 SLEEP.md 并按其执行。同时阅读昨天的日记（以覆盖 catch-up 的场景）。';
// Daily restart: fires once per day at DAILY_RESTART_AT (local HH:MM) only
// after SLEEP_COMMAND has been confirmed via Claude transcripts AND ≥1h has
// passed since it was fired — otherwise we'd kill claude mid-sleep-routine
// in the catch-up case (host boots at 05:30, supervisor fires sleep at
// 05:31, restart scheduled at 06:00 would interrupt).
const DAILY_RESTART_AT = process.env.DAILY_RESTART_AT ?? '06:00';
const RESTART_AFTER_SLEEP_MIN_HOURS = parseFloat(
  process.env.RESTART_AFTER_SLEEP_MIN_HOURS ?? '1'
);
// Window for looking back for a sleep-trigger user prompt in Claude's own
// transcripts. Needs to cover sleep-start + duration + the gap to
// DAILY_RESTART_AT (sleep at ~01:00 + ~5h gap to 06:00 + buffer).
const SLEEP_DONE_MAX_AGE_HOURS = parseFloat(
  process.env.SLEEP_DONE_MAX_AGE_HOURS ?? '8'
);
// Text that a user prompt must contain to count "sleep ran". Matches the
// SLEEP_COMMAND sent by the supervisor.
const SLEEP_TRIGGER_PATTERN = process.env.SLEEP_TRIGGER_PATTERN || 'SLEEP.md';
// Uptime fallback: if the user's host was off at DAILY_RESTART_AT the
// scheduled restart is missed. Force a restart once the current claude has
// been up longer than this. 0 disables.
const MAX_UPTIME_HOURS = parseFloat(process.env.MAX_UPTIME_HOURS ?? '24');

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

// Nuke the whole tmux session rather than SIGTERM individual children.
// Why: claude-code's TUI occasionally drops out of raw mode (stdin ends up in
// cooked+echo, keystrokes pile up as literal `^M` below the TUI, slash
// commands stop working), and the only reliable recovery is a brand-new pty.
// Killing the session + recreating on launch gives every restart a fresh pty
// and clears any accumulated termios state.
async function killProcess(bot) {
  if (!sessionExists(bot)) return false;
  try {
    sh(`tmux kill-session -t ${bot.session}`);
    return true;
  } catch {
    return false;
  }
}

// Always fresh pty: kill any existing session, then create a new one with
// start.sh as the initial command. Avoids send-keys racing a live TUI and
// sidesteps claude-code's occasional raw-mode loss (see killProcess).
async function startProcess(bot) {
  try {
    await killProcess(bot);
    sh(
      `tmux new-session -d -s ${bot.session} -c ${bot.workDir} '${START_CMD}'`
    );
    // Wait for the TUI to be actually listening for input, not just for the
    // process to exist. Sending "start" before the Telegram channel handshake
    // has finished (when `isRunning=true` but TUI is still booting) drops the
    // keystrokes on the floor and claude never runs its kickoff routine.
    // "Listening for channel messages" is printed once the TUI is live.
    const READY_MARKER = /Listening for channel messages/;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const pane = capturePane(bot, 30);
      if (pane && READY_MARKER.test(pane)) break;
    }
    execFileSync('tmux', ['send-keys', '-t', bot.target, '-l', 'start'], {
      timeout: 10_000,
    });
    execFileSync('tmux', ['send-keys', '-t', bot.target, 'Enter'], {
      timeout: 10_000,
    });
  } catch (err) {
    console.error(`[startProcess] ${bot.name}: ${err.message}`);
  }
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
  markRestart(bot.name);
  resetRestartState(bot.name);
  invalidateContextCache(bot.name);
  await startProcess(bot);
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
  if (!sessionExists(bot)) return ctx.reply(`${bot.name} not running`);
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
        // Self-heal: if claude came back (manual restart, delayed boot, etc.)
        // clear the abandoned lock too — otherwise the next crash won't
        // trigger auto-restart and the user has to /start manually.
        if (state.failures > 0 || state.abandoned) {
          state.failures = 0;
          state.abandoned = false;
        }
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
        markRestart(bot.name);
        invalidateContextCache(bot.name);
        resetRestartState(bot.name);
        await startProcess(bot);
      }
    }
  }, CONTEXT_CHECK_INTERVAL * 1000);
  console.log(
    `Context check enabled, interval: ${CONTEXT_CHECK_INTERVAL}s, threshold: >${CONTEXT_THRESHOLD}%`
  );
}

// --- Daily restart (sleep-aware) ---
// Scans Claude Code's own session transcripts at `~/.claude/projects/<slug>/`
// for a recent user message containing SLEEP_TRIGGER_PATTERN. If found, the
// bot's sleep cron fired and reached claude, so a fresh restart is safe.
// If not found, we skip the restart and alert the user — likely the bot was
// down during sleep window and forcing a restart would wipe context the bot
// never had a chance to consolidate.
function projectsDirFor(workDir) {
  // Claude Code's convention: working dir with every non-alphanumeric char
  // replaced by '-'. /workspace/foo/bar → -workspace-foo-bar
  const slug = workDir.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

function sleepTriggeredRecently(bot) {
  const dir = projectsDirFor(bot.workDir);
  const cutoffMs = Date.now() - SLEEP_DONE_MAX_AGE_HOURS * 3600_000;
  let entries;
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        try {
          return {
            file: path.join(dir, f),
            mtime: fs.statSync(path.join(dir, f)).mtimeMs,
          };
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.mtime >= cutoffMs)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return { ok: false, reason: `transcripts dir missing (${dir})` };
  }
  for (const { file } of entries) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      // Match genuine user prompts only, not tool_result-wrapped user lines:
      //   real cron prompt:  "content":"读取 ... SLEEP.md ..."
      //   tool_result wrap:  "content":[{"tool_use_id":...}]
      // The tool_result shape happens to also contain the cron's prompt text
      // when a subagent registered the cron, which would cause false hits.
      const userContentMatch = line.match(
        /"role":"user","content":"([^"]*)"/
      );
      if (!userContentMatch) continue;
      if (!userContentMatch[1].includes(SLEEP_TRIGGER_PATTERN)) continue;
      const m = line.match(/"timestamp":"([^"]+)"/);
      if (!m) continue;
      const ts = new Date(m[1]).getTime();
      if (Number.isFinite(ts) && ts >= cutoffMs) {
        return { ok: true, at: new Date(ts) };
      }
    }
  }
  return { ok: false, reason: 'no recent SLEEP.md trigger in transcripts' };
}

function claudeUptimeSeconds(bot) {
  const pid = getClaudePid(bot);
  if (!pid) return null;
  try {
    const n = parseInt(sh(`ps -o etimes= -p ${pid}`));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function parseHHMM(s) {
  const m = (s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1]);
  const mm = parseInt(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, mm };
}

function fireSleep(bot) {
  if (!isRunning(bot)) {
    console.log(`[sleep] ${bot.name}: claude not running, skipping`);
    return false;
  }
  try {
    execFileSync(
      'tmux',
      ['send-keys', '-t', bot.target, '-l', SLEEP_COMMAND],
      { timeout: 10_000 }
    );
    execFileSync('tmux', ['send-keys', '-t', bot.target, 'Enter'], {
      timeout: 10_000,
    });
    console.log(`[sleep] ${bot.name}: fired`);
    pushToUsers(`${bot.name} sleep triggered`);
    return true;
  } catch (err) {
    console.error(`[sleep] ${bot.name}: send failed: ${err.message}`);
    return false;
  }
}

const sleepTarget = SLEEP_AT ? parseHHMM(SLEEP_AT) : null;
if (SLEEP_AT && !sleepTarget) {
  console.error(`SLEEP_AT invalid: ${SLEEP_AT} (expected HH:MM)`);
}
const dailyTarget = DAILY_RESTART_AT ? parseHHMM(DAILY_RESTART_AT) : null;
if (DAILY_RESTART_AT && !dailyTarget) {
  console.error(
    `DAILY_RESTART_AT invalid: ${DAILY_RESTART_AT} (expected HH:MM)`
  );
}

// Fire-once-per-day state for both schedules. Uses the local date as the
// dedupe key so a supervisor restart mid-day doesn't re-fire events that
// already happened — except when there's no transcript evidence, in which
// case the restart's own sleep-confirmation check handles it.
const lastSleepFiredDate = new Map(); // botName → "YYYY-MM-DD"
const lastRestartFiredDate = new Map();

if (sleepTarget || dailyTarget || MAX_UPTIME_HOURS > 0) {
  setInterval(async () => {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const minutesNow = now.getHours() * 60 + now.getMinutes();

    for (const bot of BOTS) {
      if (inRestartGrace(bot.name)) continue;
      if (!sessionExists(bot)) continue;

      // --- Sleep trigger (catch-up: fire any time past SLEEP_AT today) ---
      // Track whether we fired sleep in THIS tick so the restart block below
      // can distinguish "transcript has no sleep entry because bot never
      // slept today" (legitimate skip) from "transcript lags our send-keys
      // by a tick" (must not mark restart done — retry next tick). See
      // Case B in docs: boot ≥ DAILY_RESTART_AT after host was off.
      let firedSleepThisTick = false;
      if (
        sleepTarget &&
        lastSleepFiredDate.get(bot.name) !== todayStr &&
        minutesNow >= sleepTarget.h * 60 + sleepTarget.mm
      ) {
        // Transcript check first: if claude already has a SLEEP.md user
        // message from today (e.g., supervisor restarted and lost memory),
        // don't re-fire.
        const recent = sleepTriggeredRecently(bot);
        const alreadyToday =
          recent.ok && sameLocalDate(recent.at, now);
        if (alreadyToday) {
          console.log(
            `[sleep] ${bot.name}: already fired today per transcript (at ${recent.at.toISOString()}), skipping catch-up`
          );
        } else {
          const ctx = recent.ok
            ? `transcript stale (latest SLEEP.md at ${recent.at.toISOString()})`
            : recent.reason;
          console.log(
            `[sleep] ${bot.name}: catch-up fire (minutesNow=${minutesNow}, target=${sleepTarget.h * 60 + sleepTarget.mm}; ${ctx})`
          );
          firedSleepThisTick = fireSleep(bot);
        }
        lastSleepFiredDate.set(bot.name, todayStr);
      }

      // --- Restart: scheduled daily (sleep-confirmed, ≥1h old) or uptime. ---
      let trigger = null;
      let reason = '';

      if (
        dailyTarget &&
        lastRestartFiredDate.get(bot.name) !== todayStr &&
        minutesNow >= dailyTarget.h * 60 + dailyTarget.mm
      ) {
        const check = sleepTriggeredRecently(bot);
        if (!check.ok) {
          if (firedSleepThisTick) {
            // Case B: sleep was just sent via tmux send-keys this tick, but
            // claude hasn't echoed it into the jsonl transcript yet. Do NOT
            // mark today's restart done — let the next tick see the entry
            // and fall through to the "sleep too fresh" branch below, which
            // keeps re-checking until the entry is ≥1h old.
            console.log(
              `[daily-restart] ${bot.name}: holding — sleep fired this tick (${check.reason}); transcript lag expected, will retry next tick`
            );
          } else {
            const msg = `${bot.name} daily restart skipped — ${check.reason}`;
            console.log(`[daily-restart] ${msg}`);
            pushToUsers(msg);
            lastRestartFiredDate.set(bot.name, todayStr);
          }
        } else {
          const sleepAgeMs = Date.now() - check.at.getTime();
          const minAgeMs = RESTART_AFTER_SLEEP_MIN_HOURS * 3600_000;
          if (sleepAgeMs >= minAgeMs) {
            trigger = 'daily';
            reason = `sleep confirmed at ${check.at.toISOString()} (age ${(sleepAgeMs / 3600_000).toFixed(2)}h)`;
            lastRestartFiredDate.set(bot.name, todayStr);
          } else {
            // Sleep still too fresh — wait for the next tick. Logged so
            // post-mortems can see the scheduler is actively waiting rather
            // than stuck.
            console.log(
              `[daily-restart] ${bot.name}: holding — sleep at ${check.at.toISOString()} is ${(sleepAgeMs / 60_000).toFixed(1)}m old, need ≥${(minAgeMs / 60_000).toFixed(0)}m`
            );
          }
        }
      }

      if (!trigger && MAX_UPTIME_HOURS > 0) {
        const uptime = claudeUptimeSeconds(bot);
        if (uptime !== null && uptime > MAX_UPTIME_HOURS * 3600) {
          trigger = 'uptime';
          reason = `uptime ${(uptime / 3600).toFixed(1)}h > ${MAX_UPTIME_HOURS}h`;
        }
      }

      if (trigger) {
        const msg = `${bot.name} restart [${trigger}] — ${reason}`;
        console.log(`[${trigger}-restart] ${msg}`);
        pushToUsers(msg);
        markRestart(bot.name);
        invalidateContextCache(bot.name);
        resetRestartState(bot.name);
        await startProcess(bot);
      }
    }
  }, 60_000);
  const parts = [];
  if (sleepTarget) parts.push(`sleep at ${SLEEP_AT} local`);
  if (dailyTarget)
    parts.push(
      `restart at ${DAILY_RESTART_AT} local (sleep ≥${RESTART_AFTER_SLEEP_MIN_HOURS}h old, window: ${SLEEP_DONE_MAX_AGE_HOURS}h)`
    );
  if (MAX_UPTIME_HOURS > 0) parts.push(`uptime cap: ${MAX_UPTIME_HOURS}h`);
  console.log(`Scheduler: ${parts.join('; ')}`);
}

function sameLocalDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
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
