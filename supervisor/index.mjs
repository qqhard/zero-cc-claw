#!/usr/bin/env node

import { Telegraf } from 'telegraf';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createBotManager } from './bots.mjs';
import { createCommands, UserError } from './commands.mjs';

// --- Config ---
// Supervisor bot token is OPTIONAL. When absent the supervisor runs headless:
// watchdog, context-check, sleep trigger and daily restart all still run — you
// just can't reach them from Telegram. `pushToUsers` falls back to a no-op so
// the bot-manager layer is oblivious; console.log inside `bots.mjs` is still
// the source of truth for event traces in pm2 logs.
//
// The local Unix-socket surface below is independent of the Telegram bot —
// `./supervisor/claw` works even in headless mode.
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

// --- Bot manager + shared command layer ---
const manager = createBotManager({
  bots: BOTS,
  config: MANAGER_CONFIG,
  onEvent: pushToUsers,
});

const commands = createCommands({
  bots: BOTS,
  manager,
  config: MANAGER_CONFIG,
});

// --- Telegram Bot ---
// `tg` is null when running headless. Every `tg.*` call site is either inside
// the `if (!HEADLESS)` block below or gated inside `pushToUsers`, so null-deref
// is not possible at runtime.
const tg = HEADLESS ? null : new Telegraf(BOT_TOKEN);

async function dispatchTelegram(ctx, cmd) {
  const args = ctx.message.text.split(/\s+/).slice(1);
  try {
    const text = await commands.dispatch(cmd, args);
    await ctx.reply(text);
  } catch (err) {
    if (err instanceof UserError) return ctx.reply(err.message);
    console.error(`[tg:${cmd}]`, err);
    await ctx.reply(`Internal error: ${err.message}`);
  }
}

if (!HEADLESS) {
  tg.use((ctx, next) => {
    if (ALLOWED_USERS.size && !ALLOWED_USERS.has(ctx.from?.id)) return;
    return next();
  });

  for (const cmd of [
    'status',
    'restart',
    'start',
    'stop',
    'logs',
    'screen',
    'send',
    'monitor',
    'help',
  ]) {
    tg.command(cmd, (ctx) => dispatchTelegram(ctx, cmd));
  }

  tg.on('text', (ctx) => ctx.reply('Send /help for available commands'));
}

// --- Local Unix-socket surface ---
// Same command dispatcher as Telegram — used by `supervisor/claw` (the shell
// CLI) so that `./supervisor/claw <cmd>` drives the exact same code paths as
// the Telegram bot (shared manager state, shared restart counter, shared
// monitor registry). Listens at `<cwd>/.zero-claw-supervisor.sock`; cwd is
// set by pm2 from ecosystem.config.cjs → `cwd: __dirname`, i.e. the project
// root. Permissions are 0600: anyone with filesystem access to the project
// dir can manage its bots, no wider.
const SOCKET_PATH = path.join(process.cwd(), '.zero-claw-supervisor.sock');

function unlinkSocket() {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    /* already gone */
  }
}

unlinkSocket(); // clear stale socket from a previous crash

const socketServer = net.createServer((sock) => {
  let buf = '';
  sock.setEncoding('utf-8');
  sock.on('data', (chunk) => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl);
    (async () => {
      let req;
      try {
        req = JSON.parse(line);
      } catch (err) {
        sock.end(JSON.stringify({ error: `malformed request: ${err.message}` }) + '\n');
        return;
      }
      try {
        const text = await commands.dispatch(req.cmd, req.args || []);
        sock.end(JSON.stringify({ text }) + '\n');
      } catch (err) {
        if (err instanceof UserError) {
          sock.end(JSON.stringify({ error: err.message }) + '\n');
        } else {
          console.error('[socket]', err);
          sock.end(JSON.stringify({ error: `internal: ${err.message}` }) + '\n');
        }
      }
    })();
  });
  sock.on('error', () => {}); // ignore client disconnects
});

socketServer.listen(SOCKET_PATH, () => {
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch {
    /* chmod may fail on some filesystems; not critical */
  }
  console.log(`Socket listening at ${SOCKET_PATH}`);
});
socketServer.on('error', (err) => {
  console.error(`[socket] listen failed: ${err.message}`);
});

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

// --- Shutdown ---
function shutdown(signal) {
  unlinkSocket();
  if (tg) tg.stop(signal);
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// --- Launch ---
if (!HEADLESS) {
  tg.launch();
  tg.telegram
    .setMyCommands(COMMAND_MENU)
    .catch((err) => console.error('setMyCommands failed:', err.message));
}
console.log(
  `Supervisor started${HEADLESS ? ' [headless — no remote control bot]' : ''} | bots: ${BOTS.map((b) => `${b.name}@${b.target}`).join(', ')}`
);
