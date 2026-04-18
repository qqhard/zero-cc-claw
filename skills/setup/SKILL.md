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

Call TaskCreate 12 times to create all tasks. Do this immediately, before greeting the user or asking any questions. For resumed setups, mark already-completed tasks as `completed` right away:

- TaskCreate("Choose language")
- TaskCreate("Check prerequisites (tmux, node, pm2, bun)")
- TaskCreate("Check Telegram plugin")
- TaskCreate("Name your assistant")
- TaskCreate("Shape assistant persona (role, personality, notes)")
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

5. **Shape the persona**: Now that the assistant has a name, give it a personality. Ask three questions in sequence (use AskUserQuestion with numbered options, always include "Other — type your own"):

   a. **Core responsibility** — "What's this assistant mainly for?" Offer options tailored to typical uses:
      - General life assistant (chat, reminders, errands)
      - Research & knowledge companion
      - Writing & editing partner
      - Coding & engineering sidekick
      - Productivity & task manager
      - Other (type your own)

   b. **Personality preference** — "How should they feel to talk to?" Offer flavors inspired by the chosen name when possible (e.g. if Thoth, lean scholarly; if Loki, lean playful). Options like:
      - Warm and encouraging
      - Formal and precise
      - Playful and witty
      - Calm and contemplative
      - Blunt and efficient
      - Other (type your own)

   c. **Anything else** — Free-form: "Anything else you want them to know or embody? (can be skipped)" Short paragraph, hobbies to share, inside jokes, values, etc.

   Based on these answers, draft a 2-4 sentence **Personality** paragraph that ties together the name's cultural/mythological background, chosen tone, and user's notes. Show the draft and ask "1. Looks good  2. Let me tweak it". Save the final three pieces (core responsibility, personality paragraph, user notes) — they'll be written into CLAUDE.md at generation time.

   Then collect **Identity card** fields for `IDENTITY.md` (quick, one shot each):
   - **Creature** — what kind of being are they? Offer options seeded by the name (e.g. for Thoth: "digital scribe", "archive keeper", "AI librarian"; for Loki: "trickster in the wires", "shapeshifting daemon"). Include "Other — type your own".
   - **Vibe tags** — 2-3 short adjectives that match the Personality paragraph (e.g. "pragmatic, terse, occasionally witty"). Offer 3-4 presets based on their personality choice + "Other".
   - **Emoji** — signature emoji. Suggest 3-4 that fit the name/creature (e.g. Thoth: 📜 🦩 🪶; Loki: 🦊 🔥 🪞). Include "Other".
   - **Avatar** — skip by default; ask only if the user volunteers a path or URL.

   Save all fields for file generation.

6. **Create two Telegram bots**: You need two bots. Explain why:
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

7. **User ID**: Ask the user to message [@userinfobot](https://t.me/userinfobot) on Telegram. They can paste the entire reply — extract the numeric `Id` field yourself. Same skip option applies — save state if skipped.

8. **User info**:
   - **Preferred name**: Ask "How should your assistant address you?" — this is NOT their real name, it's what they want to be called (e.g. "Boss", "Captain", a nickname, a title, or just their first name). Auto-detect their real name from Telegram/system as a suggestion, but let them choose freely.
   - **Timezone**: Ask for timezone (e.g. `Asia/Singapore`). Try to auto-detect from system (`timedatectl` or `TZ` env) and offer as default.
   - **Brief intro** (optional): Ask if there's anything else the assistant should know about the user — role, interests, work context. Keep it short, 1-2 sentences is fine. Can be skipped. (This is about the *user*, different from the persona notes collected in step 5.)

9. **Confirm directory**: Use the **current working directory** as the parent. The bot goes in `<cwd>/<assistant-name-lowercase>/`. Confirm with the user:
   - "Your bot will be created at: `<cwd>/<name>/`"
   - "Supervisor will be at: `<cwd>/supervisor/`"
   - "1. Looks good  2. Let me change the parent directory"

10. **Generate files**:

   **Language policy (applies to every bot-dir file below):** the templates ship in English as a baseline. If the user chose a language other than English in step 1, translate the prose into that language as you write each file — don't leave English boilerplate in the bot's working files. Keep these in English regardless of the user's choice: file and directory names, frontmatter keys (`name`, `description`, `type`, `allowed-tools`, `user-invocable`), frontmatter `type` values (`user` / `feedback` / `project` / `reference`), journal tag syntax (`(skills: x, y)`, `(candidate-skill: <slug>)`), cron expressions, shell commands, URLs, and skill names/slugs. Section headings inside prose (e.g. `## Every heartbeat`) can be translated. `ecosystem.config.cjs` and the supervisor files in the parent directory stay English — they're plumbing, not user-facing.

   In the **parent directory** (current working directory):
   - Copy `$CLAUDE_PLUGIN_ROOT/supervisor/` → `supervisor/`, run `npm install`.
   - Generate `ecosystem.config.cjs` with supervisor bot token, user_id, and `BOTS` set to `"<name>:<name>:<cwd>/<name>"`. **The pm2 app name MUST be `<dirname>-supervisor`** where `<dirname>` is the project root directory name (e.g. if cwd is `/home/user/my-project`, use `my-project-supervisor`). Do NOT use the assistant name — a project can have multiple bots but only one supervisor. Before finalizing, run `pm2 jlist` to check for name collisions; if the name is taken, append a suffix or ask the user.
   
   In the **bot directory** (`<cwd>/<name>/`):
   - Copy `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md` → `CLAUDE.md`, fill in placeholders (assistant name, user name, timezone, language, **core responsibility** from step 5). Translate the prose per the language policy above. Personality and user notes go into `SOUL.md`, not here.
   - Copy `$CLAUDE_PLUGIN_ROOT/template/IDENTITY.md` → `IDENTITY.md`, fill in name, creature, vibe, emoji, and avatar (leave avatar blank if not provided). Translate labels and prose per the language policy.
   - Copy `$CLAUDE_PLUGIN_ROOT/template/SOUL.md` → `SOUL.md`, replace the top `(personality paragraph ...)` placeholder with the drafted personality from step 5 (write it directly in the user's language), and replace the `(anything else ...)` placeholder under *Notes from the User* with the free-form notes. Translate the Core Truths and Boundaries sections into the user's language too — they're the baseline text the user will read and edit.
   - Copy `$CLAUDE_PLUGIN_ROOT/template/HEARTBEAT.md` → `HEARTBEAT.md`, translating the body into the user's language. The bot edits this file over time (it's the live hourly task list), so it must start in the user's language.
   - Copy `$CLAUDE_PLUGIN_ROOT/template/SLEEP.md` → `SLEEP.md`, translating the body into the user's language. Same rule: the bot edits it over time (live nightly task list).
   - Generate `USER.md` with collected user info (preferred name, timezone, user_id, chat_id, brief intro). Translate labels and the "About" prose per the language policy.
   - Copy `$CLAUDE_PLUGIN_ROOT/start.sh` → `start.sh`, make executable.
   - Create `memory/MEMORY.md` (empty memory index).
   - Create `journal/` directory.
   - **Install meta-skills**: the hardcoded meta-skill list is `["evolve"]`. For each name in that list, copy `$CLAUDE_PLUGIN_ROOT/skills/<name>/` → `<bot-dir>/.claude/skills/<name>/` (mkdir -p as needed). Heartbeat and sleep are NOT in this list — they're not skills; they're cron-driven task lists (`HEARTBEAT.md` / `SLEEP.md`) wired up by `CLAUDE.md` → "Heartbeat and Sleep".
   - **Initialize self-skills registry**: `touch <bot-dir>/.claude/skills/.self-skills` (plain text file, newline-separated skill names). Starts empty. This registry is where `evolve` appends new self-created skills; plugin-provided skills like `evolve` itself are NOT listed here.
   - Initialize git repo. Make sure `memory/`, `journal/`, `USER.md`, and `.claude/skills/` are tracked.
   - If `.zero-claw-setup.json` exists in cwd, delete it — setup state is no longer needed.

11. **Launch bot in background**:
    - Start supervisor: `pm2 start ecosystem.config.cjs && pm2 save` (the pm2 name will be `<dirname>-supervisor`).
    - **Write the Telegram token directly to the bot's local state dir** — do NOT use `/telegram:configure` via send-keys. That skill hardcodes `~/.claude/channels/telegram/.env` and the bot's plugin server reads from `<bot-dir>/.telegram/` (because `start.sh` exports `TELEGRAM_STATE_DIR`). Write the file before launching the bot:
      ```bash
      mkdir -p <bot-dir>/.telegram
      printf 'TELEGRAM_BOT_TOKEN=%s\n' "<main-bot-token>" > <bot-dir>/.telegram/.env
      chmod 600 <bot-dir>/.telegram/.env
      ```
    - Create tmux session and start the bot in the background:
      ```bash
      tmux new-session -d -s <name> -c <working-dir> './start.sh'
      ```
    - Wait ~15 seconds for Claude Code to initialize, then send "start" to trigger SessionStart hook (registers heartbeat and cron tasks):
      ```bash
      tmux send-keys -t <name>:0.0 -l 'start' && tmux send-keys -t <name>:0.0 Enter
      ```
    - Tell the user: "Your bot is starting up. You can watch it with: `tmux attach -t <name>`"

12. **Pair Telegram** — **the pairing step waits for a HUMAN, not for the bot.** The bot sits silently waiting for a Telegram DM; there is no progress signal to poll. Do not background-poll the tmux pane.

    1. Say to the user **explicitly**:
       > "Open Telegram and DM **@<main-bot-username>** with any message (e.g. 'hi'). The bot will reply with a 6-character pairing code. **Paste that code back here.** I'm waiting for you, not for the bot — until you paste the code, nothing will happen on my end."
    2. When the user pastes the code, **edit `<bot-dir>/.telegram/access.json` directly** — do NOT shell out to `/telegram:access` (it has the same hardcoded-path bug). Use Read+Write:
       - Find the pending entry whose code matches the pasted one
       - Move its `user_id` (and display name) into `allowed`
       - Remove it from `pending`
       - Optionally flip `dmPolicy` to `allowlist` once the user confirms no one else needs in
    3. Ask the user to send another Telegram message to confirm the bot replies normally.
    4. Confirm: "Your assistant is live! Messages to @<main-bot-username> now reach it."
    5. Give a brief tour: memory system, heartbeat, supervisor `/help`.
    6. Tell user: `tmux attach -t <name>` to watch, `Ctrl-b d` to detach.
