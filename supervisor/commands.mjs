// Shared command layer. Called by both the Telegram bot (index.mjs) and the
// local Unix-socket CLI (supervisor/zeroclaw). Each handler returns a plain-text
// string on success, or throws `UserError` for expected user-facing errors
// (bad bot name, missing argument, etc.). Any other thrown error is an
// internal bug.
//
// Output is plain text. Telegram's MarkdownV2 is strict and easy to break;
// template/CLAUDE.md explicitly asks us to default to plain text. Dropping
// HTML here keeps the two surfaces (Telegram + CLI) byte-identical.
//
// `surface` selects which commands are exposed. `monitor` is Telegram-only:
// it pushes pane diffs back to Telegram, which is where they're useful.
// Running it from the CLI would just enable Telegram pushes you can't see
// locally, so the CLI surface hides the subcommand altogether.

import fs from 'node:fs';

export class UserError extends Error {}

// Read last N lines of a file without slurping the whole thing. Reads at
// most the trailing 256KB — enough for any reasonable tail request, bounded
// so a giant pm2 log doesn't balloon memory. Returns null on I/O error.
function tailFile(filePath, n) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return '';
    const maxBytes = 256 * 1024;
    const bytesToRead = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, stat.size - bytesToRead);
    fs.closeSync(fd);
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    // Drop the first (likely partial) line if we started mid-file.
    if (bytesToRead < stat.size) lines.shift();
    return lines.slice(-n).join('\n');
  } catch {
    return null;
  }
}

export function createCommands({ manager, bots, config, surface = 'telegram' }) {
  const includeMonitor = surface !== 'cli';
  const botsByName = new Map(bots.map((b) => [b.name, b]));

  function resolveBot(name) {
    if (!name && bots.length === 1) return bots[0];
    if (!name) {
      throw new UserError(
        `Multiple bots configured. Specify which one:\n${bots
          .map((b) => `  ${b.name}`)
          .join('\n')}`
      );
    }
    const bot = botsByName.get(name);
    if (!bot) {
      throw new UserError(
        `Unknown bot: ${name}\nAvailable: ${bots.map((b) => b.name).join(', ')}`
      );
    }
    return bot;
  }

  function formatTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  async function formatContextLine(bot) {
    const usage = await manager.getContextUsage(bot);
    if (!usage) return 'context: query failed';
    const age = Math.round((Date.now() - usage.at) / 1000);
    const tokens = `${formatTokens(usage.tokens)} / ${formatTokens(usage.limit)}`;
    const model = usage.model ? `\nmodel: ${usage.model}` : '';
    return `context: ${tokens} (${usage.pct}%) · ${age}s ago` + model;
  }

  async function formatStatusLine(bot) {
    const claudePid = manager.getClaudePid(bot);
    const header = claudePid
      ? `${bot.name} — running`
      : `${bot.name} — stopped`;
    const parts = [header];
    if (claudePid) parts.push(`pid: ${claudePid}`);
    if (!manager.sessionExists(bot)) parts.push('tmux session not found');
    const state = manager.getRestartState(bot.name);
    if (state.abandoned) {
      parts.push(
        `auto-restart disabled (${config.MAX_CONSECUTIVE_RESTARTS} failures) — start ${bot.name} to re-enable`
      );
    } else if (state.failures > 0) {
      parts.push(
        `recent restarts: ${state.failures}/${config.MAX_CONSECUTIVE_RESTARTS}`
      );
    }
    if (claudePid) parts.push(await formatContextLine(bot));
    return parts.join('\n');
  }

  const handlers = {
    async status(botName) {
      if (!botName && bots.length > 1) {
        const lines = await Promise.all(bots.map((b) => formatStatusLine(b)));
        return lines.join('\n\n');
      }
      const bot = resolveBot(botName);
      return formatStatusLine(bot);
    },

    async restart(botName) {
      const bot = resolveBot(botName);
      manager.unmarkStopped(bot.name);
      manager.markRestart(bot.name);
      manager.resetRestartState(bot.name);
      manager.invalidateContextCache(bot.name);
      await manager.startProcess(bot);
      return `${bot.name} restarted`;
    },

    async stop(botName) {
      const bot = resolveBot(botName);
      if (!manager.sessionExists(bot)) return `${bot.name} not running`;
      await manager.killProcess(bot);
      manager.resetRestartState(bot.name);
      manager.invalidateContextCache(bot.name);
      manager.markStopped(bot.name);
      return `${bot.name} stopped`;
    },

    async start(botName) {
      const bot = resolveBot(botName);
      if (manager.isRunning(bot)) return `${bot.name} already running`;
      manager.unmarkStopped(bot.name);
      await manager.startProcess(bot);
      manager.markRestart(bot.name);
      manager.resetRestartState(bot.name);
      manager.invalidateContextCache(bot.name);
      return `${bot.name} started`;
    },

    async logs(lines) {
      // Supervisor's own logs, not a bot's pane. pm2 injects the log paths
      // into the child env (`pm_out_log_path` / `pm_err_log_path`), so we
      // read them directly — no dependency on `pm2` CLI being available.
      const n = Number.isFinite(lines) && lines > 0 ? lines : 80;
      const outPath = process.env.pm_out_log_path;
      const errPath = process.env.pm_err_log_path;
      if (!outPath && !errPath) {
        throw new UserError(
          'Supervisor logs unavailable (not running under pm2)'
        );
      }
      const sections = [];
      if (outPath) {
        const content = tailFile(outPath, n);
        if (content?.trim()) sections.push(`=== stdout ===\n${content}`);
      }
      if (errPath) {
        const content = tailFile(errPath, n);
        if (content?.trim()) sections.push(`=== stderr ===\n${content}`);
      }
      if (sections.length === 0) return 'No supervisor logs';
      const text = sections.join('\n\n');
      return text.length > 4000 ? '...' + text.slice(-4000) : text;
    },

    async screen(botName, lines) {
      const bot = resolveBot(botName);
      const n = Number.isFinite(lines) && lines > 0 ? lines : 30;
      const content = manager.capturePane(bot, n);
      if (!content?.trim()) return 'No screen';
      return content;
    },

    async send(botName, text) {
      const bot = resolveBot(botName);
      if (!text) throw new UserError('Usage: send [bot] <text>');
      if (!manager.sessionExists(bot)) {
        throw new UserError(`${bot.name} not running`);
      }
      manager.sendKeys(bot, text);
      return 'Sent';
    },

    async monitor(action, botName, seconds) {
      const act = (action || 'status').toLowerCase();
      if (act === 'status') {
        const running = manager.listMonitors();
        if (running.length === 0) {
          return 'Monitor: off\nUsage: monitor on [bot] [seconds]';
        }
        return (
          'Monitor:\n' +
          running.map(({ name, seconds: s }) => `${name}: every ${s}s`).join('\n')
        );
      }
      if (act !== 'on' && act !== 'off') {
        throw new UserError('Usage: monitor [on|off|status] [bot] [seconds]');
      }
      const bot = resolveBot(botName);
      if (act === 'on') {
        const interval =
          Number.isFinite(seconds) && seconds >= 5
            ? seconds
            : manager.DEFAULT_MONITOR_SECONDS;
        manager.startMonitor(bot, interval);
        return `Monitoring ${bot.name} every ${interval}s`;
      }
      if (manager.stopMonitor(bot)) return `Stopped monitoring ${bot.name}`;
      return `${bot.name} was not being monitored`;
    },

    help() {
      const botHint =
        bots.length > 1
          ? `\n\nBots: ${bots.map((b) => b.name).join(', ')}\nAdd bot name after the subcommand, e.g. status ${bots[0].name}`
          : '';
      const lines = [
        'status [bot] - Status, restart counter, context usage',
        'restart [bot] - Restart bot',
        'start [bot] - Start bot (re-enables auto-restart)',
        'stop [bot] - Stop bot',
        'logs [lines] - Supervisor logs (default 80 lines)',
        'screen [bot] [lines] - Current bot screen (default 30 lines)',
        'send [bot] <text> - Type text into the bot TUI',
      ];
      if (includeMonitor) {
        lines.push('monitor [on|off|status] [bot] [seconds] - Push new pane output');
      }
      lines.push('help - This message');
      return lines.join('\n') + botHint;
    },
  };

  // Shared positional-arg dispatcher. Both the Telegram command handlers and
  // the socket server normalize their inputs to (cmd, args[]) and hand off
  // here — this is the one source of truth for how args map to handlers.
  async function dispatch(cmd, args = []) {
    const botNames = new Set(bots.map((b) => b.name));

    switch (cmd) {
      case undefined:
      case '':
      case 'help':
        return handlers.help();

      case 'status':
        return handlers.status(args[0]);
      case 'restart':
        return handlers.restart(args[0]);
      case 'start':
        return handlers.start(args[0]);
      case 'stop':
        return handlers.stop(args[0]);
      case 'logs': {
        const lines =
          args[0] && /^\d+$/.test(args[0]) ? parseInt(args[0]) : undefined;
        return handlers.logs(lines);
      }
      case 'screen': {
        let rest = args.slice();
        let botName;
        let lines;
        if (rest[0] && botNames.has(rest[0])) {
          botName = rest[0];
          rest = rest.slice(1);
        }
        if (rest[0] && /^\d+$/.test(rest[0])) {
          lines = parseInt(rest[0]);
        }
        return handlers.screen(botName, lines);
      }

      case 'send': {
        // First positional is the bot name only if it actually matches one;
        // otherwise the whole rest is the message (single-bot shortcut, and
        // also a safety net so you can `send hi` when hi isn't a bot name).
        if (args[0] && botNames.has(args[0])) {
          return handlers.send(args[0], args.slice(1).join(' '));
        }
        return handlers.send(undefined, args.join(' '));
      }

      case 'monitor': {
        if (!includeMonitor) {
          throw new UserError(`Unknown command: ${cmd}\nTry 'help'`);
        }
        const act = args[0] || 'status';
        let rest = args.slice(1);
        let botName;
        let seconds;
        if (rest[0] && botNames.has(rest[0])) {
          botName = rest[0];
          rest = rest.slice(1);
        }
        if (rest[0] && /^\d+$/.test(rest[0])) {
          seconds = parseInt(rest[0]);
        }
        return handlers.monitor(act, botName, seconds);
      }

      default:
        throw new UserError(`Unknown command: ${cmd}\nTry 'help'`);
    }
  }

  return { ...handlers, dispatch };
}
