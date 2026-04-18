---
description: Supervisor commands (status/restart/start/stop/logs/screen/send/monitor). Mirrors the Telegram supervisor bot.
argument-hint: <status|restart|start|stop|logs|screen|send|monitor|help> [bot] [args...]
allowed-tools: Bash(node:*)
---

Run the supervisor CLI with the user's arguments: `$ARGUMENTS`

Execute:

```bash
node "$CLAUDE_PLUGIN_ROOT/supervisor/cli.mjs" $ARGUMENTS
```

The CLI talks to the same supervisor process that Telegram uses, via a local Unix socket — so `status`, `restart`, `stop`, `start`, `logs`, `screen`, `send`, and `monitor` behave identically here and on Telegram.

Print the CLI output verbatim. Do not paraphrase, reformat, or add commentary. If the CLI exits non-zero (e.g. supervisor not running), just show its stderr message.
