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

## UX Rules

**Always present choices as numbered options** so the user gets a clickable selection bar. Never ask open-ended questions when you can offer options. For example:

- Language: "1. English  2. 中文  3. 日本語  4. Other (type it)"
- Timezone: auto-detect first, then "1. Asia/Singapore (detected)  2. Other (type it)"
- Assistant name: "1. Thoth — Egyptian god of knowledge  2. Athena — Greek goddess of wisdom  3. ..."
- Working directory: "1. <current directory> (current)  2. ~/<assistant-name> (recommended)  3. Custom path"
- Confirmations: "1. Yes  2. No, let me change"

When the user must paste something (bot token, user ID), ask for the paste directly — no options needed there.

Plugin root is available as `$CLAUDE_PLUGIN_ROOT`.

## Steps

**IMPORTANT — Do this FIRST before anything else:**

Call TaskCreate 11 times to create all tasks. Do this immediately, before greeting the user or asking any questions:

- TaskCreate("Choose language")
- TaskCreate("Check prerequisites (tmux, node, pm2)")
- TaskCreate("Check Telegram plugin")
- TaskCreate("Create two Telegram bots (main + supervisor)")
- TaskCreate("Configure Telegram plugin")
- TaskCreate("Get Telegram user ID")
- TaskCreate("Collect user info (name, timezone, assistant name)")
- TaskCreate("Choose working directory")
- TaskCreate("Generate project files")
- TaskCreate("Start supervisor")
- TaskCreate("Introduction & launch")

Then for each step below: TaskUpdate → `in_progress` when starting, `completed` when done.

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
   If not installed, run `claude plugins install telegram`.

4. **Create two Telegram bots**: Guide the user to open [@BotFather](https://t.me/BotFather) and create two bots. Explain why two:
   - **Main bot** — your assistant's face, for daily conversation. Suggest names based on the assistant name chosen later (or ask to come back and rename). Username like `myname_bot` or `myname_assistant_bot`.
   - **Supervisor bot** — remote control for when the main bot is unresponsive. Lets you restart, check status, view logs. Username like `myname_supervisor_bot`.
   
   For each bot, tell the user to paste the **entire BotFather response** — parse the token yourself using regex: `/\d+:[A-Za-z0-9_-]{35,}/`. Clearly label which is which when confirming back.

5. **Configure Telegram plugin**: Guide the user through the full pairing flow:
   1. Run `/telegram:configure` — this saves the **main bot** token
   2. Tell the user: "Now open Telegram and send any message to your main bot (@xxx_bot)"
   3. The bot will reply with a 6-character pairing code
   4. Tell the user to paste that code here
   5. Run `/telegram:access pair <code>` to complete the pairing
   6. Confirm success: "Your Telegram is now connected. Messages you send to @xxx_bot will reach this assistant."

6. **User ID**: Ask the user to message [@userinfobot](https://t.me/userinfobot) on Telegram. They can paste the entire reply — extract the numeric `Id` field yourself.

7. **User info**:
   - **Preferred name**: Ask "How should your assistant address you?" — this is NOT their real name, it's what they want to be called (e.g. "Boss", "Captain", a nickname, a title, or just their first name). Auto-detect their real name from Telegram/system as a suggestion, but let them choose freely.
   - **Timezone**: Ask for timezone (e.g. `Asia/Singapore`). Try to auto-detect from system (`timedatectl` or `TZ` env) and offer as default.
   - **Brief intro** (optional): Ask if there's anything else the assistant should know — role, interests, work context. Keep it short, 1-2 sentences is fine. Can be skipped.
   - **Assistant name**: Ask the user to name their assistant. Suggest 3-5 names from mythology, folklore, or fiction — pick randomly from diverse cultures and pantheons each time (Greek, Norse, Egyptian, Hindu, Chinese, Japanese, Celtic, Mesopotamian, etc.). For each suggestion, give a one-line reason why the name fits an AI assistant (e.g. knowledge, wisdom, communication, protection). Let the user pick one or type their own.

8. **Working directory**: Default to `~/<assistant-name-lowercase>` (e.g. if assistant is "Thoth", default `~/thoth`). Let the user confirm or change.

9. **Generate files** in the working directory:
   - Copy `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md` → `CLAUDE.md`, fill in all placeholders (assistant name, user name, timezone, language).
   - Copy `$CLAUDE_PLUGIN_ROOT/supervisor/` → `supervisor/`, run `npm install`.
   - Generate `ecosystem.config.cjs` with the collected values. Use `<assistant-name-lowercase>` as the `TMUX_SESSION` name and the **supervisor bot token**.
   - Generate `USER.md` with collected user info (preferred name, timezone, user_id, chat_id, brief intro). This is the assistant's reference for who the user is.
   - Copy `$CLAUDE_PLUGIN_ROOT/start.sh` → `start.sh`, make executable.
   - Create `memory/MEMORY.md` (empty memory index).
   - Create `journal/` directory.
   - Initialize git repo. Make sure `memory/`, `journal/`, and `USER.md` are tracked.

10. **Start supervisor**: Run `pm2 start ecosystem.config.cjs && pm2 save`.

11. **Introduction & launch**: Before saying goodbye, give the user a brief tour of what their assistant can do:

    **Core capabilities** (built-in):
    - Chat via Telegram — send any message to the main bot
    - Run code, read/write files, search the web — all via natural language
    - MCP tool integration (Gmail, Calendar, Notion, etc. — can be added later)

    **Memory system** (self-managed, git-tracked):
    - `USER.md` — your profile, continuously updated as the assistant learns about you
    - `journal/` — daily logs of what happened (written each heartbeat)
    - `memory/` — long-term memory distilled from journals
    - All in the project directory, git-tracked, portable across machines

    **Heartbeat** (automatic, waking hours only):
    - Registered as a cron job on every session start
    - Only fires during your waking hours (no disturbance at night)
    - Each hour: sends "online" status, records notable events to journal
    - Last heartbeat of the day: distills journal into long-term memory, prunes stale entries
    - Monday's last heartbeat: weekly review

    **Supervisor bot** — send `/help` to your supervisor bot to see all commands:
    - `/restart` — restart the assistant when it's stuck
    - `/status` — check if it's running
    - `/logs` / `/screen` — see what's on the terminal
    - `/send <text>` — type into the assistant's terminal

    **How to launch**:
    ```bash
    tmux new-session -s <name> -c ~/<name> './start.sh'
    ```
    Detach: `Ctrl-b d`. Re-attach: `tmux attach -t <name>`.
