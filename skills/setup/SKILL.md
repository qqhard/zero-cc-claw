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

6. **User info**:
   - **User's name**: Auto-detect from Telegram profile or system info. Confirm with the user, don't make them type it.
   - **Timezone**: Ask for timezone (e.g. `Asia/Singapore`). Try to auto-detect from system (`timedatectl` or `TZ` env) and offer as default.
   - **Assistant name**: Ask the user to name their assistant. Suggest 3-5 names from mythology, folklore, or fiction — pick randomly from diverse cultures and pantheons each time (Greek, Norse, Egyptian, Hindu, Chinese, Japanese, Celtic, Mesopotamian, etc.). For each suggestion, give a one-line reason why the name fits an AI assistant (e.g. knowledge, wisdom, communication, protection). Let the user pick one or type their own.

7. **Working directory**: Default to `~/<assistant-name-lowercase>` (e.g. if assistant is "Thoth", default `~/thoth`). Let the user confirm or change.

8. **Generate files** in the working directory:
   - Copy `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md` → `CLAUDE.md`, fill in all placeholders (assistant name, user name, timezone, language).
   - Copy `$CLAUDE_PLUGIN_ROOT/supervisor/` → `supervisor/`, run `npm install`.
   - Generate `ecosystem.config.cjs` with the collected values. Use `<assistant-name-lowercase>` as the `TMUX_SESSION` name.
   - Copy `$CLAUDE_PLUGIN_ROOT/start.sh` → `start.sh`, make executable.
   - Create `memory/MEMORY.md` (empty).
   - Create `memory/journal/` directory.
   - Initialize git repo.

9. **Start supervisor**: Run `pm2 start ecosystem.config.cjs && pm2 save`.

10. **Summary**: Tell the user everything is ready. Show how to launch (using assistant name as tmux session):
    ```bash
    tmux new-session -s <name> -c ~/<name> './start.sh'
    ```
    This attaches the user directly into the tmux session so they can watch Claude Code start up. To detach later: `Ctrl-b d`. To re-attach: `tmux attach -t <name>`.
    
    Also remind them of supervisor bot commands: `/status`, `/restart`, etc.
