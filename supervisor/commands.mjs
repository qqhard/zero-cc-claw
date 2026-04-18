// Shared command layer. Called by both the Telegram bot (index.mjs) and the
// local Unix-socket CLI (cli.mjs). Each handler returns a plain-text string
// on success, or throws `UserError` for expected user-facing errors (bad bot
// name, missing argument, etc.). Any other thrown error is an internal bug.
//
// Output is plain text. Telegram's MarkdownV2 is strict and easy to break;
// template/CLAUDE.md explicitly asks us to default to plain text. Dropping
// HTML here keeps the two surfaces (Telegram + CLI) byte-identical.

export class UserError extends Error {}

export function createCommands({ manager, bots, config }) {
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
    return (
      `context: ${tokens} (${usage.pct}%) · ${age}s ago · restart >${config.CONTEXT_THRESHOLD}%` +
      model
    );
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

    async logs(botName) {
      const bot = resolveBot(botName);
      const content = manager.capturePane(bot, 80);
      if (!content?.trim()) return 'No logs';
      return content.length > 4000 ? '...' + content.slice(-4000) : content;
    },

    async screen(botName) {
      const bot = resolveBot(botName);
      const content = manager.capturePane(bot, 30);
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
      return (
        'status [bot] - Status, restart counter, context usage\n' +
        'restart [bot] - Restart bot\n' +
        'start [bot] - Start bot (re-enables auto-restart)\n' +
        'stop [bot] - Stop bot\n' +
        'logs [bot] - Recent logs (80 lines)\n' +
        'screen [bot] - Current screen (30 lines)\n' +
        'send [bot] <text> - Type text into the bot TUI\n' +
        'monitor [on|off|status] [bot] [seconds] - Push new pane output\n' +
        'help - This message' +
        botHint
      );
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
      case 'logs':
        return handlers.logs(args[0]);
      case 'screen':
        return handlers.screen(args[0]);

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
