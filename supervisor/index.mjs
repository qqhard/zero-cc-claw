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
const WATCHDOG_INTERVAL = parseInt(process.env.WATCHDOG_INTERVAL || '0');
const BOOT_DELAY = parseInt(process.env.BOOT_DELAY || '10');

// Parse BOTS: "name:session:dir,name2:session2:dir2"
// Falls back to legacy single-bot env vars
function parseBots() {
  const botsEnv = process.env.BOTS || '';
  if (botsEnv) {
    return botsEnv.split(',').map((entry) => {
      const [name, session, workDir] = entry.split(':');
      return { name, session, target: `${session}:0.0`, workDir };
    });
  }
  // Legacy single-bot fallback
  const session = process.env.TMUX_SESSION || 'bot';
  const workDir = process.env.WORK_DIR || process.cwd();
  return [{ name: session, session, target: `${session}:0.0`, workDir }];
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
  await ctx.reply(`${bot.name} stopped`);
});

tg.command('start', async (ctx) => {
  const bot = parseBotArg(ctx);
  if (!bot) return;
  if (isRunning(bot)) return ctx.reply(`${bot.name} already running`);
  startProcess(bot);
  await ctx.reply(`${bot.name} started`);
});

tg.command('status', async (ctx) => {
  // No arg + multiple bots → show all
  const text = ctx.message.text;
  const arg = text.split(/\s+/)[1];

  if (!arg && BOTS.length > 1) {
    const lines = BOTS.map((b) => {
      const pid = getClaudePid(b);
      return `${b.name}: ${pid ? `running (PID ${pid})` : 'stopped'}`;
    });
    return ctx.reply(lines.join('\n'));
  }

  const bot = parseBotArg(ctx);
  if (!bot) return;
  const claudePid = getClaudePid(bot);
  const parts = [claudePid ? `${bot.name}: running` : `${bot.name}: stopped`];
  if (claudePid) parts.push(`PID: ${claudePid}`);
  if (!sessionExists(bot)) parts.push('tmux session not found');
  await ctx.reply(parts.join('\n'));
});

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

tg.command('help', (ctx) => {
  const botHint =
    BOTS.length > 1
      ? `\n\nBots: ${BOTS.map((b) => b.name).join(', ')}\nAdd bot name after command, e.g. /status ${BOTS[0].name}`
      : '';
  ctx.reply(
    '/restart - Restart bot\n' +
      '/stop - Stop bot\n' +
      '/start - Start bot\n' +
      '/status - Status (all bots if no arg)\n' +
      '/logs - Recent logs (80 lines)\n' +
      '/screen - Current screen\n' +
      '/send <text> - Type into TUI\n' +
      '/help - This message' +
      botHint
  );
});

tg.on('text', (ctx) => ctx.reply('Send /help for available commands'));

// --- Watchdog ---
if (WATCHDOG_INTERVAL > 0) {
  setInterval(() => {
    for (const bot of BOTS) {
      if (!isRunning(bot) && sessionExists(bot)) {
        console.log(`[watchdog] ${bot.name} died, restarting...`);
        startProcess(bot);
        for (const uid of ALLOWED_USERS) {
          tg.telegram
            .sendMessage(uid, `${bot.name} crashed — auto-restarted`)
            .catch(() => {});
        }
      }
    }
  }, WATCHDOG_INTERVAL * 1000);
  console.log(`Watchdog enabled, interval: ${WATCHDOG_INTERVAL}s`);
}

// --- Launch ---
tg.launch();
console.log(
  `Supervisor started | bots: ${BOTS.map((b) => `${b.name}@${b.target}`).join(', ')}`
);

process.once('SIGINT', () => tg.stop('SIGINT'));
process.once('SIGTERM', () => tg.stop('SIGTERM'));
