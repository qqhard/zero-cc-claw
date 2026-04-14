#!/bin/bash
cd "$(dirname "$0")"
# Each bot gets its own Telegram state dir for token/access isolation
export TELEGRAM_STATE_DIR="$(pwd)/.telegram"
claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions --project-dir .
