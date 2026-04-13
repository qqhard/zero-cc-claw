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

## UX Rules

**Always present choices as numbered options** so the user gets a clickable selection bar. Never ask open-ended questions when you can offer options. For example:

- Language: "1. English  2. 中文  3. 日本語  4. Other (type it)"
- Timezone: auto-detect first, then "1. Asia/Singapore (detected)  2. Other (type it)"
- Assistant name: "1. Thoth — Egyptian god of knowledge  2. Athena — Greek goddess of wisdom  3. ..."
- Working directory: "1. <current directory> (current)  2. ~/<assistant-name> (recommended)  3. Custom path"
- Confirmations: "1. Yes  2. No, let me change"

When the user must paste something (bot token, user ID), ask for the paste directly — no options needed there.

## Steps

**IMPORTANT — Do this FIRST before anything else:**

Call TaskCreate 10 times to create all tasks. Do this immediately, before greeting the user or asking any questions:

- TaskCreate("Choose language")
- TaskCreate("Check prerequisites (tmux, node, pm2)")
- TaskCreate("Check Telegram plugin")
- TaskCreate("Create two Telegram bots (main + supervisor)")
- TaskCreate("Get Telegram user ID")
- TaskCreate("Collect user info (name, timezone, assistant name)")
- TaskCreate("Choose working directory")
- TaskCreate("Generate project files")
- TaskCreate("Start supervisor & launch")
- TaskCreate("Pair Telegram")

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

5. **User ID**: Ask the user to message [@userinfobot](https://t.me/userinfobot) on Telegram. They can paste the entire reply — extract the numeric `Id` field yourself.

6. **User info**:
   - **Preferred name**: Ask "How should your assistant address you?" — this is NOT their real name, it's what they want to be called (e.g. "Boss", "Captain", a nickname, a title, or just their first name). Auto-detect their real name from Telegram/system as a suggestion, but let them choose freely.
   - **Timezone**: Ask for timezone (e.g. `Asia/Singapore`). Try to auto-detect from system (`timedatectl` or `TZ` env) and offer as default.
   - **Brief intro** (optional): Ask if there's anything else the assistant should know — role, interests, work context. Keep it short, 1-2 sentences is fine. Can be skipped.
   - **Assistant name**: Ask the user to name their assistant. Suggest 3-5 names from mythology, folklore, or fiction — pick randomly from diverse cultures and pantheons each time (Greek, Norse, Egyptian, Hindu, Chinese, Japanese, Celtic, Mesopotamian, etc.). For each suggestion, give a one-line reason why the name fits an AI assistant (e.g. knowledge, wisdom, communication, protection). Let the user pick one or type their own.

7. **Working directory**: Default to `~/<assistant-name-lowercase>` (e.g. if assistant is "Thoth", default `~/thoth`). Present options: "1. <current dir> (current)  2. ~/<name> (recommended)  3. Custom path". Let the user confirm or change.

8. **Generate files** in the working directory:
   - Copy `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md` → `CLAUDE.md`, fill in all placeholders (assistant name, user name, timezone, language).
   - Copy `$CLAUDE_PLUGIN_ROOT/supervisor/` → `supervisor/`, run `npm install`.
   - Generate `ecosystem.config.cjs` with the collected values. Use `<assistant-name-lowercase>` as the `TMUX_SESSION` name and the **supervisor bot token**.
   - Generate `USER.md` with collected user info (preferred name, timezone, user_id, chat_id, brief intro). This is the assistant's reference for who the user is.
   - Copy `$CLAUDE_PLUGIN_ROOT/start.sh` → `start.sh`, make executable.
   - Create `memory/MEMORY.md` (empty memory index).
   - Create `journal/` directory.
   - Initialize git repo. Make sure `memory/`, `journal/`, and `USER.md` are tracked.

9. **Launch bot in background**:
   - Start supervisor: `pm2 start ecosystem.config.cjs && pm2 save`
   - Create tmux session and start the bot in the background:
     ```bash
     tmux new-session -d -s <name> -c <working-dir> './start.sh'
     ```
   - Wait ~10 seconds for Claude Code to initialize
   - Configure Telegram plugin by sending the main bot token into the tmux session:
     ```bash
     tmux send-keys -t <name>:0.0 -l '/telegram:configure' && tmux send-keys -t <name>:0.0 Enter
     ```
     Wait a few seconds, then send the main bot token:
     ```bash
     tmux send-keys -t <name>:0.0 -l '<main-bot-token>' && tmux send-keys -t <name>:0.0 Enter
     ```
   - Tell the user: "Your bot is starting up. You can watch it with: `tmux attach -t <name>`"

10. **Pair Telegram**:
    1. Tell the user: "Open Telegram and send any message (e.g. 'hello') to your main bot @xxx_bot"
    2. Wait for the user to confirm. Two possible outcomes:
       - **Bot replies normally** → already paired, no further action needed
       - **Bot replies with a 6-char pairing code** → ask the user to paste the code, then send into the bot session:
         ```bash
         tmux send-keys -t <name>:0.0 -l '/telegram:access pair <code>' && tmux send-keys -t <name>:0.0 Enter
         ```
    3. Confirm: "Your assistant is live! Messages to @xxx_bot now reach it."
    4. Give a brief tour: memory system, heartbeat, supervisor `/help`
    5. Tell user: `tmux attach -t <name>` to watch, `Ctrl-b d` to detach
