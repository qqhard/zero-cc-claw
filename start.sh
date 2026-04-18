#!/bin/bash
# Env + launch. Nothing else. Crash diagnostics live where they belong
# (supervisor, pm2 logs), not here.
cd "$(dirname "$0")"
export TELEGRAM_STATE_DIR="$(pwd)/.telegram"

# Node defaults to UTC inside pm2 children even when /etc/timezone is set,
# so CronCreate schedules would fire at the wrong hour. Pick up host TZ as
# a fallback if the caller didn't export it.
if [ -z "$TZ" ] && [ -r /etc/timezone ]; then
  export TZ="$(cat /etc/timezone)"
fi

# Run claude, then drop into a login shell when it exits. This keeps the
# hosting tmux pane alive (and not "dead") on /exit, Ctrl-C×2, or a crash —
# whether the pane was created by the supervisor or by a user running
# `./start.sh` manually under their own tmux. Without this, claude exiting
# would close the last pane and cascade the tmux session dead; the supervisor
# watchdog would still recover, but any attached user would be booted out.
claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions
exec bash -l
