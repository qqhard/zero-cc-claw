---
name: setup
description: "First-run setup wizard for Zero-Claw. Triggers: 'setup bot', 'configure assistant', 'zero-claw setup', or when ecosystem.config.cjs has empty SUPERVISOR_BOT_TOKEN."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
  - TaskCreate
  - TaskUpdate
---

# Zero-Claw Setup

Interactive setup wizard. Guide the user step by step.

Plugin root is available as `$CLAUDE_PLUGIN_ROOT`.

## Before Starting

Use TaskCreate to create **all** tasks upfront so the user sees the full picture:

1. "Choose language"
2. "Check prerequisites (tmux, node, pm2)"
3. "Check Telegram plugin"
4. "Create supervisor bot (via BotFather)"
5. "Get Telegram user ID"
6. "Collect user info (name, timezone)"
7. "Choose working directory"
8. "Generate project files"
9. "Start supervisor"
10. "Verify and launch"

Mark each task `in_progress` when starting it, `completed` when done.

## Steps

1. **Language**: Ask the user's preferred language. Continue in that language.

2. **Prerequisites**: Check installed tools:
   ```bash
   tmux --version
   node --version
   pm2 --version
   ```
   If anything is missing, tell the user what to install and stop.

3. **Telegram plugin**: Check if the Telegram plugin is installed:
   ```bash
   claude plugins list 2>/dev/null | grep telegram
   ```
   If not installed, tell the user to run `claude plugins install telegram` first, then re-run setup.

4. **Supervisor bot token**: This bot is your remote control — it lets you restart, stop, and monitor the assistant from Telegram when the main bot is unresponsive. Ask the user to:
   - Open [@BotFather](https://t.me/BotFather) on Telegram
   - Create a new bot (`/newbot`)
   - Suggest names like `MyName Supervisor`, `MyName Watchdog`, `MyName Control`; username like `myname_supervisor_bot`
   - Paste the **entire BotFather response** here — no need to extract the token manually
   - Parse the token from the pasted text yourself using regex: `/\d+:[A-Za-z0-9_-]{35,}/`

5. **User ID**: Ask the user to message [@userinfobot](https://t.me/userinfobot) on Telegram. They can paste the entire reply — extract the numeric `Id` field yourself.

6. **User info**: Ask for name and timezone (e.g. `Asia/Singapore`).

7. **Working directory**: Ask where to set up the bot project (default: `~/zero-claw-bot`). Create the directory.

8. **Generate files** in the working directory:
   - Copy `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md` → `CLAUDE.md`, fill in user info and language.
   - Copy `$CLAUDE_PLUGIN_ROOT/supervisor/` → `supervisor/`, run `npm install`.
   - Generate `ecosystem.config.cjs` with the collected values.
   - Copy `$CLAUDE_PLUGIN_ROOT/start.sh` → `start.sh`, make executable.
   - Create `memory/MEMORY.md` (empty).
   - Create `memory/journal/` directory.
   - Initialize git repo.

9. **Start supervisor**: Run `pm2 start ecosystem.config.cjs && pm2 save`.

10. **Summary**: Tell the user everything is ready. Show how to launch:
    ```bash
    tmux new-session -d -s bot -c ~/zero-claw-bot
    tmux send-keys -t bot:0.0 './start.sh' Enter
    ```
    And how to control via supervisor bot: `/status`, `/restart`, etc.
