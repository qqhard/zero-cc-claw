#!/bin/bash
cd "$(dirname "$0")"
# Each bot gets its own Telegram state dir for token/access isolation
export TELEGRAM_STATE_DIR="$(pwd)/.telegram"

# Make claude's Node runtime (and its CronCreate) use the host's timezone.
# Without this, Node defaults to UTC inside pm2 children even if /etc/timezone
# is set — leading to cron schedules interpreted as UTC when the user wrote
# them in local time.
if [ -z "$TZ" ] && [ -r /etc/timezone ]; then
  export TZ="$(cat /etc/timezone)"
fi

# Preserve crash evidence across tmux session resets. stdout stays on the TTY
# so the TUI renders normally; only stderr + exit status hit the log file.
# This is the only durable record of why claude died — supervisor only sees
# "process gone" and the tmux pane gets overwritten by the next launch.
LOG="$(pwd)/.claude-crash.log"
{
  echo ""
  echo "=== $(date -Iseconds) start.sh launching claude (pid=$$) ==="
} >>"$LOG"

claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions 2>>"$LOG"
EXIT=$?

echo "=== $(date -Iseconds) claude exited status=$EXIT ===" >>"$LOG"
