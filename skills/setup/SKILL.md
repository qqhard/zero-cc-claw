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
---

# Zero-Claw Setup

Interactive setup wizard. Guide the user step by step.

Plugin root is available as `$CLAUDE_PLUGIN_ROOT`.

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

4. **Supervisor bot token**: Ask the user to create a bot via [@BotFather](https://t.me/BotFather) and paste the token.

5. **User ID**: Ask the user to message [@userinfobot](https://t.me/userinfobot) and paste their Telegram user_id.

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
