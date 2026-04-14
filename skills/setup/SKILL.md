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

Check if `<cwd>/.zero-claw-setup.json` exists. If it does, this is a **resumed setup** — read the file, pre-fill all previously collected values, and skip completed steps. Greet the user with "Welcome back! Picking up where you left off." and show what's already configured vs. what's still needed.

Call TaskCreate 11 times to create all tasks. Do this immediately, before greeting the user or asking any questions. For resumed setups, mark already-completed tasks as `completed` right away:

- TaskCreate("Choose language")
- TaskCreate("Check prerequisites (tmux, node, pm2, bun)")
- TaskCreate("Check Telegram plugin")
- TaskCreate("Name your assistant")
- TaskCreate("Create two Telegram bots (main + supervisor)")
- TaskCreate("Get Telegram user ID")
- TaskCreate("Collect user info (name, timezone)")
- TaskCreate("Choose working directory")
- TaskCreate("Generate project files")
- TaskCreate("Start supervisor & launch")
- TaskCreate("Pair Telegram")

Then for each step below: TaskUpdate → `in_progress` when starting, `completed` when done.

1. **Language**: Use AskUserQuestion: "What language should we use? / 使用什么语言？"
   - English
   - 中文
   - 日本語 (or another suggested language based on system locale)
   - (Other — user types their own)
   
   Continue in that language.

2. **Prerequisites**: Check installed tools:
   ```bash
   tmux --version
   node --version
   pm2 --version
   bun --version
   ```
   If anything is missing, offer to install it (e.g. `npm install -g pm2`, `curl -fsSL https://bun.sh/install | bash`). Only stop if installation fails.

3. **Telegram plugin**: Check if the Telegram plugin is installed:
   ```bash
   claude plugins list 2>/dev/null | grep telegram
   ```
   If not installed, run `claude plugins install telegram`.

4. **Name your assistant**: Ask the user to name their assistant. Suggest 3-5 names from mythology, folklore, or fiction — pick randomly from diverse cultures and pantheons each time (Greek, Norse, Egyptian, Hindu, Chinese, Japanese, Celtic, Mesopotamian, etc.). For each suggestion, give a one-line reason why the name fits an AI assistant (e.g. knowledge, wisdom, communication, protection). Let the user pick one or type their own. Save the chosen name — it will be used to suggest Telegram bot usernames next.

5. **Create two Telegram bots**: You need two bots. Explain why:
   - **Main bot** — your assistant's face, for daily conversation.
   - **Supervisor bot** — remote control for when the main bot is unresponsive. Lets you restart, check status, view logs.

   For **each** bot, guide the user through BotFather step by step:

   > 1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
   > 2. Send `/newbot`
   > 3. BotFather asks for a **display name** — suggest: `<AssistantName>` for main, `<AssistantName> Supervisor` for supervisor
   > 4. BotFather asks for a **username** (must end in `bot`) — suggest: `<name>_bot` for main, `<name>_supervisor_bot` for supervisor (use the assistant name lowercase, try variations if taken)
   > 5. BotFather replies with the token — copy it

   Then ask how they want to provide the token. Present options:
   - **Paste token directly** — if they already copied the `123456:ABC-DEF...` token
   - **Paste BotFather's full reply** — parse the token using regex: `/\d+:[A-Za-z0-9_-]{35,}/`
   - **Skip for now** — save progress and continue; they can provide it later by running `/zero-claw:setup` again

   If the user skips either bot token, write the current setup state to `<cwd>/.zero-claw-setup.json` with collected values so far (language, assistant name, any tokens already provided, etc.). When setup is run again, check for this file first and resume from where the user left off — pre-fill known values and only ask for missing ones.

   After collecting each token, confirm back: "✓ Main bot token: `<first 8 chars>...` — @username" (or "✓ Supervisor bot token: ...").

6. **User ID**: Ask the user to message [@userinfobot](https://t.me/userinfobot) on Telegram. They can paste the entire reply — extract the numeric `Id` field yourself. Same skip option applies — save state if skipped.

7. **User info**:
   - **Preferred name**: Ask "How should your assistant address you?" — this is NOT their real name, it's what they want to be called (e.g. "Boss", "Captain", a nickname, a title, or just their first name). Auto-detect their real name from Telegram/system as a suggestion, but let them choose freely.
   - **Timezone**: Ask for timezone (e.g. `Asia/Singapore`). Try to auto-detect from system (`timedatectl` or `TZ` env) and offer as default.
   - **Brief intro** (optional): Ask if there's anything else the assistant should know — role, interests, work context. Keep it short, 1-2 sentences is fine. Can be skipped.

8. **Confirm directory**: Use the **current working directory** as the parent. The bot goes in `<cwd>/<assistant-name-lowercase>/`. Confirm with the user:
   - "Your bot will be created at: `<cwd>/<name>/`"
   - "Supervisor will be at: `<cwd>/supervisor/`"
   - "1. Looks good  2. Let me change the parent directory"

9. **Generate files**:
   
   In the **parent directory** (current working directory):
   - Copy `$CLAUDE_PLUGIN_ROOT/supervisor/` → `supervisor/`, run `npm install`.
   - Generate `ecosystem.config.cjs` with supervisor bot token, user_id, and `BOTS` set to `"<name>:<name>:<cwd>/<name>"`. **The pm2 app name MUST be `<dirname>-supervisor`** where `<dirname>` is the project root directory name (e.g. if cwd is `/home/user/my-project`, use `my-project-supervisor`). Do NOT use the assistant name — a project can have multiple bots but only one supervisor. Before finalizing, run `pm2 jlist` to check for name collisions; if the name is taken, append a suffix or ask the user.
   
   In the **bot directory** (`<cwd>/<name>/`):
   - Copy `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md` → `CLAUDE.md`, fill in all placeholders (assistant name, user name, timezone, language).
   - Generate `USER.md` with collected user info (preferred name, timezone, user_id, chat_id, brief intro).
   - Copy `$CLAUDE_PLUGIN_ROOT/start.sh` → `start.sh`, make executable.
   - Create `memory/MEMORY.md` (empty memory index).
   - Create `journal/` directory.
   - Initialize git repo. Make sure `memory/`, `journal/`, and `USER.md` are tracked.
   - If `.zero-claw-setup.json` exists in cwd, delete it — setup state is no longer needed.

10. **Launch bot in background**:
    - Start supervisor: `pm2 start ecosystem.config.cjs && pm2 save` (the pm2 name will be `<assistant-name>-supervisor`)
    - Create tmux session and start the bot in the background:
      ```bash
      tmux new-session -d -s <name> -c <working-dir> './start.sh'
      ```
    - Wait ~15 seconds for Claude Code to initialize
    - Send "start" to trigger SessionStart hook (registers heartbeat and cron tasks):
      ```bash
      tmux send-keys -t <name>:0.0 -l 'start' && tmux send-keys -t <name>:0.0 Enter
      ```
    - Wait a few seconds, then configure Telegram plugin:
      ```bash
      tmux send-keys -t <name>:0.0 -l '/telegram:configure' && tmux send-keys -t <name>:0.0 Enter
      ```
    - Wait a few seconds, then send the main bot token:
      ```bash
      tmux send-keys -t <name>:0.0 -l '<main-bot-token>' && tmux send-keys -t <name>:0.0 Enter
      ```
    - Tell the user: "Your bot is starting up. You can watch it with: `tmux attach -t <name>`"

11. **Pair Telegram**:
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
