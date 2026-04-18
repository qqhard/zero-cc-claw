#!/usr/bin/env node

import { Telegraf } from 'telegraf';
import { createBotManager } from './bots.mjs';

// --- Config ---
// Supervisor bot token is OPTIONAL. When absent the supervisor runs headless:
// watchdog, context-check, sleep trigger and daily restart all still run — you
// just can't reach them from Telegram. `pushToUsers` falls back to a no-op so
// the bot-manager layer is oblivious; console.log inside `bots.mjs` is still
// the source of truth for event traces in pm2 logs.
const BOT_TOKEN = process.env.SUPERVISOR_BOT_TOKEN;
const HEADLESS = !BOT_TOKEN;

const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USERS || '').split(',').filter(Boolean).map(Number)
);

const CONTEXT_THRESHOLD = parseInt(process.env.CONTEXT_THRESHOLD ?? '50');

const MANAGER_CONFIG = {
  START_CMD: process.env.START_CMD || './start.sh',
  WATCHDOG_INTERVAL: parseInt(process.env.WATCHDOG_INTERVAL ?? '60'),
  MAX_CONSECUTIVE_RESTARTS: parseInt(
    process.env.MAX_CONSECUTIVE_RESTARTS ?? '5'
  ),
  CONTEXT_CHECK_INTERVAL: parseInt(
    process.env.CONTEXT_CHECK_INTERVAL ?? '86400'
  ),
  CONTEXT_THRESHOLD,
  // Reuse a /context result before re-querying. Running /context adds a line
  // to the bot's TUI history, so we don't want to hit it on every /status
  // call. Daily context-check uses the same cache with a 24h interval, so it
  // always forces a fresh query naturally.
  CONTEXT_CACHE_SECONDS: parseInt(process.env.CONTEXT_CACHE_SECONDS ?? '300'),
  // Upper bound on how long we'll wait for /context to render before giving
  // up. bots.mjs polls the pane (every 500ms) inside this window — fast
  // renders return in ~1s, slow ones (TUI busy) keep retrying up to the cap.
  // Raised from 4s to 8s because a busy TUI routinely slipped past 4s.
  CONTEXT_QUERY_WAIT_MS: parseInt(process.env.CONTEXT_QUERY_WAIT_MS ?? '8000'),
  MONITOR_INTERVAL: parseInt(process.env.MONITOR_INTERVAL || '0'),
  MONITOR_CAPTURE_LINES: parseInt(process.env.MONITOR_CAPTURE_LINES || '500'),
  // Sleep + daily restart: both supervisor-driven so they survive a host that
  // was off at the scheduled time (bot's own cron would never fire in that
  // window; supervisor catches up on next tick). See bots.mjs for full notes.
  SLEEP_AT: process.env.SLEEP_AT ?? '01:00',
  SLEEP_COMMAND:
    process.env.SLEEP_COMMAND ||
    '读取 SLEEP.md 并按其执行。同时阅读昨天的日记（以覆盖 catch-up 的场景）。',
  DAILY_RESTART_AT: process.env.DAILY_RESTART_AT ?? '06:00',
  RESTART_AFTER_SLEEP_MIN_HOURS: parseFloat(
    process.env.RESTART_AFTER_SLEEP_MIN_HOURS ?? '1'
  ),
  SLEEP_DONE_MAX_AGE_HOURS: parseFloat(
    process.env.SLEEP_DONE_MAX_AGE_HOURS ?? '8'
  ),
  SLEEP_TRIGGER_PATTERN: process.env.SLEEP_TRIGGER_PATTERN || 'SLEEP.md',
  MAX_UPTIME_HOURS: parseFloat(process.env.MAX_UPTIME_HOURS ?? '24'),
};

// Parse BOTS: "name:session:dir,name2:session2:dir2"
// Falls back to legacy single-bot env vars.
function parseBots() {
  const botsEnv = process.env.BOTS || '';
  if (botsEnv) {
    return botsEnv.split(',').map((entry) => {
      const [name, session, workDir] = entry.split(':');
      return { name, session, target: session, workDir };
    });
  }
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

// --- Telegram push ---
// onEvent callback handed to the manager. In headless mode the manager never
// calls it (because we pass a no-op), which means event text only lands in
// pm2 console logs. With a bot, we fan out to every allowlisted user.
function pushToUsers(text) {
  if (HEADLESS) return;
  for (const uid of ALLOWED_USERS) {
    tg.telegram.sendMessage(uid, text).catch(() => {});
  }
}

// --- Bot manager ---
const manager = createBotManager({
  bots: BOTS,
  config: MANAGER_CONFIG,
  onEvent: pushToUsers,
});

// --- Telegram Bot ---
// `tg` is null when running headless. Every `tg.*` call site is either inside
// the `if (!HEADLESS)` block below or gated inside `pushToUsers`, so null-deref
// is not possible at runtime.
const tg = HEADLESS ? null : new Telegraf(BOT_TOKEN);

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
  const usage = await manager.getContextUsage(bot);
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
  const claudePid = manager.getClaudePid(bot);
  const header = claudePid
    ? `<b>${escapeHtml(bot.name)}</b> — running`
    : `<b>${escapeHtml(bot.name)}</b> — <b>stopped</b>`;
  const parts = [header];
  if (claudePid) parts.push(`pid: <code>${claudePid}</code>`);
  if (!manager.sessionExists(bot)) parts.push('<i>tmux session not found</i>');
  const state = manager.getRestartState(bot.name);
  if (state.abandoned) {
    parts.push(
      `<i>auto-restart disabled (${MANAGER_CONFIG.MAX_CONSECUTIVE_RESTARTS} failures) — /start ${escapeHtml(bot.name)} to re-enable</i>`
    );
  } else if (state.failures > 0) {
    parts.push(
      `<i>recent restarts: ${state.failures}/${MANAGER_CONFIG.MAX_CONSECUTIVE_RESTARTS}</i>`
    );
  }
  if (claudePid) parts.push(await formatContextLine(bot));
  return parts.join('\n');
}

if (!HEADLESS) {
  tg.use((ctx, next) => {
    if (ALLOWED_USERS.size && !ALLOWED_USERS.has(ctx.from?.id)) return;
    return next();
  });

  tg.command('restart', async (ctx) => {
    const bot = parseBotArg(ctx);
    if (!bot) return;
    const msg = await ctx.reply(`Restarting ${bot.name}...`);
    manager.unmarkStopped(bot.name);
    manager.markRestart(bot.name);
    manager.resetRestartState(bot.name);
    manager.invalidateContextCache(bot.name);
    await manager.startProcess(bot);
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
    if (!manager.sessionExists(bot)) return ctx.reply(`${bot.name} not running`);
    await manager.killProcess(bot);
    manager.resetRestartState(bot.name);
    manager.invalidateContextCache(bot.name);
    manager.markStopped(bot.name);
    await ctx.reply(`${bot.name} stopped`);
  });

  tg.command('start', async (ctx) => {
    const bot = parseBotArg(ctx);
    if (!bot) return;
    if (manager.isRunning(bot)) return ctx.reply(`${bot.name} already running`);
    manager.unmarkStopped(bot.name);
    manager.startProcess(bot);
    manager.markRestart(bot.name);
    manager.resetRestartState(bot.name);
    manager.invalidateContextCache(bot.name);
    await ctx.reply(`${bot.name} started`);
  });

  tg.command('status', async (ctx) => {
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

  tg.command('logs', async (ctx) => {
    const bot = parseBotArg(ctx);
    if (!bot) return;
    const content = manager.capturePane(bot, 80);
    if (!content?.trim()) return ctx.reply('No logs');
    const text = content.length > 4000 ? '...' + content.slice(-4000) : content;
    await ctx.reply(text);
  });

  tg.command('screen', async (ctx) => {
    const bot = parseBotArg(ctx);
    if (!bot) return;
    const content = manager.capturePane(bot, 30);
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
    manager.sendKeys(bot, text);
    await ctx.reply('Sent');
  });

  tg.command('monitor', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const action = (parts[0] || 'status').toLowerCase();

    if (action === 'status') {
      const running = manager.listMonitors();
      if (running.length === 0) {
        return ctx.reply('Monitor: off\nUsage: /monitor on [bot] [seconds]');
      }
      const lines = running.map(
        ({ name, seconds }) => `${name}: every ${seconds}s`
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
          : manager.DEFAULT_MONITOR_SECONDS;
      manager.startMonitor(bot, interval);
      return ctx.reply(`Monitoring ${bot.name} every ${interval}s`);
    }

    if (manager.stopMonitor(bot)) {
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
if (!HEADLESS) {
  tg.launch();
  tg.telegram
    .setMyCommands(COMMAND_MENU)
    .catch((err) => console.error('setMyCommands failed:', err.message));
  process.once('SIGINT', () => tg.stop('SIGINT'));
  process.once('SIGTERM', () => tg.stop('SIGTERM'));
}
console.log(
  `Supervisor started${HEADLESS ? ' [headless — no remote control bot]' : ''} | bots: ${BOTS.map((b) => `${b.name}@${b.target}`).join(', ')}`
);
