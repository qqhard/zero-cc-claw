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
const TMUX_SESSION = process.env.TMUX_SESSION || 'bot';
const TMUX_TARGET = `${TMUX_SESSION}:0.0`;
const WORK_DIR = process.env.WORK_DIR || process.cwd();
const START_CMD = process.env.START_CMD || './start.sh';
const WATCHDOG_INTERVAL = parseInt(process.env.WATCHDOG_INTERVAL || '0');

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

// --- tmux ---
function sessionExists() {
  try {
    sh(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function ensureSession() {
  if (!sessionExists()) {
    sh(`tmux new-session -d -s ${TMUX_SESSION} -c ${WORK_DIR}`);
  }
}

function getPanePid() {
  try {
    return parseInt(
      sh(`tmux display-message -t ${TMUX_TARGET} -p '#{pane_pid}'`)
    );
  } catch {
    return null;
  }
}

function getClaudePid() {
  const panePid = getPanePid();
  if (!panePid) return null;
  try {
    const children = sh(`pgrep -P ${panePid}`)
      .split('\n')
      .filter(Boolean)
      .map(Number);
    for (const pid of children) {
      try {
        const cmd = sh(`cat /proc/${pid}/cmdline 2>/dev/null`);
        if (cmd.startsWith('claude')) return pid;
        const grandchildren = sh(`pgrep -P ${pid}`)
          .split('\n')
          .filter(Boolean)
          .map(Number);
        for (const gc of grandchildren) {
          const gcCmd = sh(`cat /proc/${gc}/cmdline 2>/dev/null`);
          if (gcCmd.startsWith('claude')) return gc;
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

function isRunning() {
  return getClaudePid() !== null;
}

async function killProcess() {
  const panePid = getPanePid();
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
    if (!isRunning()) return true;
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

function startProcess() {
  ensureSession();
  sh(`tmux send-keys -t ${TMUX_TARGET} 'cd ${WORK_DIR} && ${START_CMD}' Enter`);
}

function capturePane(lines = 50) {
  try {
    return stripAnsi(
      sh(`tmux capture-pane -t ${TMUX_TARGET} -p -S -${lines}`)
    );
  } catch {
    return null;
  }
}

// --- Bot ---
const bot = new Telegraf(BOT_TOKEN);

bot.use((ctx, next) => {
  if (ALLOWED_USERS.size && !ALLOWED_USERS.has(ctx.from?.id)) return;
  return next();
});

bot.command('restart', async (ctx) => {
  const msg = await ctx.reply('Restarting...');
  await killProcess();
  startProcess();
  await ctx.telegram.editMessageText(
    ctx.chat.id,
    msg.message_id,
    null,
    'Restarted'
  );
});

bot.command('stop', async (ctx) => {
  if (!isRunning()) return ctx.reply('Not running');
  await killProcess();
  await ctx.reply('Stopped');
});

bot.command('start', async (ctx) => {
  if (isRunning()) return ctx.reply('Already running');
  startProcess();
  await ctx.reply('Started');
});

bot.command('status', async (ctx) => {
  const claudePid = getClaudePid();
  const parts = [claudePid ? 'Running' : 'Stopped'];
  if (claudePid) parts.push(`claude PID: ${claudePid}`);
  if (!sessionExists()) parts.push('tmux session not found');
  await ctx.reply(parts.join('\n'));
});

bot.command('logs', async (ctx) => {
  const content = capturePane(80);
  if (!content?.trim()) return ctx.reply('No logs');
  const text = content.length > 4000 ? '...' + content.slice(-4000) : content;
  await ctx.reply(text);
});

bot.command('screen', async (ctx) => {
  const content = capturePane(30);
  if (!content?.trim()) return ctx.reply('No screen');
  await ctx.reply(content);
});

bot.command('send', async (ctx) => {
  const text = ctx.message.text.replace(/^\/send\s*/, '');
  if (!text) return ctx.reply('Usage: /send <text>');
  execFileSync('tmux', ['send-keys', '-t', TMUX_TARGET, '-l', text], {
    timeout: 10_000,
  });
  execFileSync('tmux', ['send-keys', '-t', TMUX_TARGET, 'Enter'], {
    timeout: 10_000,
  });
  await ctx.reply('Sent');
});

bot.command('help', (ctx) =>
  ctx.reply(
    '/restart - Restart Claude Code\n' +
      '/stop - Stop\n' +
      '/start - Start\n' +
      '/status - Status\n' +
      '/logs - Recent logs (80 lines)\n' +
      '/screen - Current screen\n' +
      '/send <text> - Type into TUI\n' +
      '/help - This message'
  )
);

bot.on('text', (ctx) => ctx.reply('Send /help for available commands'));

// --- Watchdog ---
if (WATCHDOG_INTERVAL > 0) {
  setInterval(() => {
    if (!isRunning() && sessionExists()) {
      console.log('[watchdog] process died, restarting...');
      startProcess();
      for (const uid of ALLOWED_USERS) {
        bot.telegram
          .sendMessage(uid, 'Claude Code crashed — auto-restarted')
          .catch(() => {});
      }
    }
  }, WATCHDOG_INTERVAL * 1000);
  console.log(`Watchdog enabled, interval: ${WATCHDOG_INTERVAL}s`);
}

// --- Launch ---
bot.launch();
console.log(`Supervisor started | tmux: ${TMUX_TARGET}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
