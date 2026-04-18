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

Call TaskCreate 14 times to create all tasks. Do this immediately, before greeting the user or asking any questions. For resumed setups, mark already-completed tasks as `completed` right away:

- TaskCreate("Pre-authorize setup permissions")
- TaskCreate("Choose language")
- TaskCreate("Check prerequisites (tmux, node, pm2, bun)")
- TaskCreate("Check Telegram plugin")
- TaskCreate("Name your assistant")
- TaskCreate("Shape assistant persona (role, personality, notes)")
- TaskCreate("Create two Telegram bots (assistant + Supervisor)")
- TaskCreate("Get Telegram user ID")
- TaskCreate("Collect user info (name, timezone)")
- TaskCreate("Choose working directory")
- TaskCreate("Choose bot runtime permission mode")
- TaskCreate("Generate project files")
- TaskCreate("Start supervisor & launch")
- TaskCreate("Pair Telegram")

Then for each step below: TaskUpdate → `in_progress` when starting, `completed` when done.

0. **Pre-authorize setup permissions**: setup runs many shell commands (tmux, pm2, npm, git) and many file writes. Without pre-authorization, the user has to click "Allow" dozens of times — death by a thousand prompts. Ask ONCE up front:

   Use AskUserQuestion:
   > "Setup will run commands like `tmux`, `pm2`, `npm install`, `git`, and write files into this directory. May I add these to `<cwd>/.claude/settings.local.json` so you don't have to approve each one?"
   > - **Yes, pre-authorize** (recommended) — writes the allow list; local to this project, not committed to git.
   > - **No, ask me each time** — proceed without pre-auth.

   If the user chooses pre-authorize, Write `<cwd>/.claude/settings.local.json` with this content (merge into existing allow list if file already exists):
   ```json
   {
     "permissions": {
       "allow": [
         "Bash(tmux:*)",
         "Bash(pm2:*)",
         "Bash(npm install:*)",
         "Bash(npm:*)",
         "Bash(node:*)",
         "Bash(bun:*)",
         "Bash(claude plugins:*)",
         "Bash(git init:*)",
         "Bash(git add:*)",
         "Bash(git commit:*)",
         "Bash(git config:*)",
         "Bash(git status:*)",
         "Bash(mkdir:*)",
         "Bash(chmod:*)",
         "Bash(touch:*)",
         "Bash(cp:*)",
         "Bash(printf:*)",
         "Bash(timedatectl:*)",
         "Bash(cat:*)"
       ]
     }
   }
   ```
   Then do this: **Write the file first**, then proceed. The user's upcoming Bash calls will match these prefixes and auto-approve. If the file already exists, merge — don't clobber existing entries. Tell the user: "Pre-authorized — settings saved to `<cwd>/.claude/settings.local.json`. You can edit or delete this file anytime."

   If the user declines, continue without writing — they'll be prompted per command, which is fine for a paranoid user.

   (This step is skipped on **resumed setup** if pre-auth has already been written — detect by reading `.claude/settings.local.json` and checking if the relevant entries are present.)

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

5. **Shape the persona**: Now that the assistant has a name, give it a personality. **ONE AskUserQuestion call, five tabs on one screen.** Persona is a single big question with orthogonal dimensions — not a series of refining rounds. Do not split this into multiple rounds, and do not ask variants of the same dimension twice (e.g. "personality" in one round and "vibe tags" in the next — that's the same question asked twice, and it trains the user to pick anything). Users can always edit `SOUL.md` later.

   Single AskUserQuestion with these five questions (tabs):

   a. **Role** — "What's this assistant mainly for?" Offer options tailored to typical uses:
      - General life assistant (chat, reminders, errands)
      - Research & knowledge companion
      - Writing & editing partner
      - Coding & engineering sidekick
      - Productivity & task manager
      - Other (type your own)

   b. **Speaking style** — "How should they sound when they talk?" Offer flavors inspired by the chosen name when possible (e.g. if Thoth, lean scholarly; if Loki, lean playful). Options like:
      - Warm and encouraging
      - Formal and precise
      - Playful and witty
      - Calm and contemplative
      - Blunt and efficient
      - Other (type your own)

   c. **Thinking style** — "How should they reason through things?" This is distinct from speaking style — it's about *how they form* a recommendation, not how they phrase it:
      - Systematic and structured (weighs options, lays out trade-offs)
      - Intuitive and fast (goes with the gut, refines on pushback)
      - Skeptical and probing (questions assumptions before committing)
      - Exploratory and associative (connects ideas across domains)
      - Pragmatic and bottom-line (skips analysis, says the answer)
      - Other (type your own)

   d. **Execution habits** — "How should they interact with you while working?" Orthogonal to both above — this is about *conversational rhythm*, not content:
      - Ask one question at a time, wait for each answer
      - Ask a batch of related questions up front, then proceed
      - Proceed on reasonable assumptions, check in only at decision points
      - Always confirm before taking any external action (send, post, commit)
      - Move fast, apologize later (surface the action, not the permission)
      - Other (type your own)

   e. **Anything else** — free-form additions. "Anything else you want them to embody, know, or avoid?" First option: `Skip (leave blank)`. Then 2-3 concrete example options to prompt thinking (e.g. "Never pretend to know — say 'I'm not sure'", "Always show their work when reasoning", "Keep replies under 3 lines unless asked for more"). Plus "Other (type your own)".

   **Derive, don't ask** for the identity-card surface attributes — they're auto-filled into `SOUL.md`'s header bullets:
   - **Creature** — auto-pick from the name's cultural background (e.g. Thoth → "digital scribe"; Loki → "trickster in the wires").
   - **Vibe tags** — 2-3 adjectives auto-derived from the speaking-style + thinking-style answers.
   - **Emoji** — auto-pick one emoji that fits the name or role.
   - **Avatar** — skipped by default; only ask if the user volunteers a path or URL.

   **Do NOT ask a separate "paragraph confirm" round.** Draft the 2-4 sentence Core Truths paragraph yourself from the five answers + the name's cultural background, and write it straight into `SOUL.md`.

   In the wrap-up, tell the user in one line: *"I've filled in `SOUL.md` — identity card, core responsibility, personality paragraph. Edit anytime."*

   Everything lands in one file, `SOUL.md`:
   - name / creature / vibe / emoji / avatar → header bullets
   - role answer → `## Core Responsibility` paragraph
   - speaking + thinking + execution answers woven together → `## Core Truths` personality paragraph (above the baseline bullet principles)
   - free-form extras → `## Notes from the User` (leave placeholder text if the user picked Skip)

6. **Create two Telegram bots**: lead with the *scenario*, not the labels. Frame it like this (translate to the user's language):

   > You'll create two Telegram bots in BotFather. Here's why two:
   >
   > 1. **`<AssistantName>` itself** — the bot you chat with every day. When you DM it, `<AssistantName>` answers.
   > 2. **A Supervisor bot** — think of it as a monitoring channel. If `<AssistantName>` ever hangs, crashes, or stops replying, you can't ask it to fix itself — you DM the Supervisor bot instead. It can restart `<AssistantName>`, show status, tail logs.
   >
   > Two bots, not one, because the out-of-band channel has to survive the main one being broken.

   Always refer to them concretely in user-facing prose — never say "main bot" alone (it's vague):
   - Bot #1: **`<AssistantName>` bot** (or just the assistant's name).
   - Bot #2: **Supervisor bot** — in Chinese pair it with **监控** (e.g. "Supervisor（监控）bot"), in Japanese **監視**. The English word "Supervisor" stays in every language as the recognizable term; the parenthesized native word makes its *purpose* (monitoring the first bot) obvious.

   Do them **one at a time** — never ask the user to create both in the same round. Finish bot #1 (BotFather walk-through → token collected → confirmed) before even mentioning bot #2. Two BotFather dances back-to-back confuse people about which token belongs where.

   For **each** bot, guide the user through BotFather step by step:

   > 1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
   > 2. Send `/newbot`
   > 3. BotFather asks for a **display name** — suggest: `<AssistantName>` for bot #1, `<AssistantName> Supervisor` for bot #2
   > 4. BotFather asks for a **username** (must end in `bot`) — suggest: `<name>_bot` for bot #1, `<name>_supervisor_bot` for bot #2 (use the assistant name lowercase, try variations if taken)
   > 5. BotFather replies with the token — copy it

   Then ask how they want to provide the token. Present options:
   - **Paste token directly** — if they already copied the `123456:ABC-DEF...` token
   - **Paste BotFather's full reply** — parse the token using regex: `/\d+:[A-Za-z0-9_-]{35,}/`
   - **Skip for now** — save progress and continue; they can provide it later by running `/zero-claw:setup` again

   If the user skips either bot token, write the current setup state to `<cwd>/.zero-claw-setup.json` with collected values so far (language, assistant name, any tokens already provided, etc.). When setup is run again, check for this file first and resume from where the user left off — pre-fill known values and only ask for missing ones.

   After collecting each token, confirm back using the concrete label: "✓ `<AssistantName>` bot token: `<first 8 chars>...` — @username" (or "✓ Supervisor bot token: ...").

7. **User ID**: Ask the user to message [@userinfobot](https://t.me/userinfobot) on Telegram. They can paste the entire reply — extract the numeric `Id` field yourself. Same skip option applies — save state if skipped.

8. **User info**:
   - **Preferred name**: Ask "How should your assistant address you?" — this is NOT their real name, it's what they want to be called (e.g. "Boss", "Captain", a nickname, a title, or just their first name). Auto-detect their real name from Telegram/system as a suggestion, but let them choose freely.
   - **Timezone**: Ask for timezone (e.g. `Asia/Singapore`). Try to auto-detect from system (`timedatectl` or `TZ` env) and offer as default.
   - **Brief intro** (optional): Ask if there's anything else the assistant should know about the user — role, interests, work context. Keep it short, 1-2 sentences is fine. Can be skipped. (This is about the *user*, different from the persona notes collected in step 5.)

9. **Confirm directory**: Use the **current working directory** as the parent. The bot goes in `<cwd>/<assistant-name-lowercase>/`. Confirm with the user:
   - "Your bot will be created at: `<cwd>/<name>/`"
   - "Supervisor will be at: `<cwd>/supervisor/`"
   - "1. Looks good  2. Let me change the parent directory"

9b. **Choose bot runtime permission mode**: the bot's `start.sh` needs to decide how the long-running Claude Code session treats tool permissions. There are two modes — pick ONE and remember the choice (it decides how step 10 writes `start.sh` and whether to generate `<bot-dir>/.claude/settings.json`):

   Use AskUserQuestion:
   > "How should the bot handle tool permissions when it runs?"
   > - **Bypass mode** (recommended, current default) — start.sh runs Claude with `--dangerously-skip-permissions`. On first launch Telegram/tmux will show one "Yes, I accept" modal; after that the bot acts freely. Simplest; matches a personal-assistant threat model where the bot fully represents the user.
   > - **Granular mode (acceptEdits + allowlist)** — strip `--dangerously-skip-permissions` from start.sh, and pre-write `<bot-dir>/.claude/settings.json` with a broad allow list (Bash, file ops, WebFetch/WebSearch). Same effective capability as bypass but no startup modal, and the allow list is in a file the user can audit or tighten later.

   Persist `MODE = bypass | granular` for use in steps 10 and 11. On **resumed setup**, re-read this from `.zero-claw-setup.json` or detect from the already-generated `start.sh` / `settings.json`.

10. **Generate files**:

   **Language policy (applies to every bot-dir file below EXCEPT `CLAUDE.md`):** the templates ship in English as a baseline. If the user chose a language other than English in step 1, translate the prose into that language as you write each file — don't leave English boilerplate in the bot's working files. `CLAUDE.md` is the one exception: it's the system mechanism, copied verbatim and kept in English across all bots so upgrades are plain replacements. Keep these in English regardless of the user's choice: file and directory names, frontmatter keys (`name`, `description`, `type`, `allowed-tools`, `user-invocable`), frontmatter `type` values (`user` / `feedback` / `project` / `reference`), journal tag syntax (`(skills: x, y)`, `(candidate-skill: <slug>)`), cron expressions, shell commands, URLs, and skill names/slugs. Section headings inside prose (e.g. `## Every heartbeat`) can be translated. `ecosystem.config.cjs` and the supervisor files in the parent directory stay English — they're plumbing, not user-facing.

   In the **parent directory** (current working directory):
   - Copy `$CLAUDE_PLUGIN_ROOT/supervisor/` → `supervisor/`, run `npm install`.
   - Generate `ecosystem.config.cjs` with supervisor bot token, user_id, and `BOTS` set to `"<name>:<name>:<cwd>/<name>"`. **The pm2 app name MUST be `<dirname>-supervisor`** where `<dirname>` is the project root directory name (e.g. if cwd is `/home/user/my-project`, use `my-project-supervisor`). Do NOT use the assistant name — a project can have multiple bots but only one supervisor. Before finalizing, run `pm2 jlist` to check for name collisions; if the name is taken, append a suffix or ask the user.
   
   In the **bot directory** (`<cwd>/<name>/`):
   - Copy `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md` → `CLAUDE.md` **verbatim**. Do NOT fill any placeholders and do NOT translate it — this file has no placeholders anymore; it's the system mechanism, identical across all bots.
   - Copy `$CLAUDE_PLUGIN_ROOT/template/SOUL.md` → `SOUL.md` and fill it in from the step 5 answers, in the user's language:
     - Header bullets — name, creature (auto-picked), vibe (auto-derived), emoji (auto-picked), avatar (leave blank if not provided).
     - `## Core Responsibility` — the paragraph drafted from step 5a.
     - `## Core Truths` — replace the top `(personality paragraph ...)` placeholder with the drafted personality (speaking + thinking + execution woven together). Keep the baseline bullet principles (Be genuinely helpful / Have opinions / …), translated into the user's language.
     - `## Boundaries` — translate the baseline bullets into the user's language.
     - `## Notes from the User` — if the user provided free-form extras in step 5e, insert them; otherwise leave the `(anything else ...)` placeholder in place (translated) as an invite for the user to fill in later.
   - Copy `$CLAUDE_PLUGIN_ROOT/template/HEARTBEAT.md` → `HEARTBEAT.md`, translating the body into the user's language. The bot edits this file over time (it's the live hourly task list), so it must start in the user's language.
   - Copy `$CLAUDE_PLUGIN_ROOT/template/SLEEP.md` → `SLEEP.md`, translating the body into the user's language. Same rule: the bot edits it over time (live nightly task list).
   - Copy `$CLAUDE_PLUGIN_ROOT/template/CRONTAB.md` → `CRONTAB.md`, translating the body into the user's language. Leaves the table empty by default — the user (or the bot, at user's request) adds rows later.
   - Generate `USER.md` with collected user info (preferred name, timezone, user_id, chat_id, brief intro). Translate labels and the "About" prose per the language policy.
   - Copy `$CLAUDE_PLUGIN_ROOT/start.sh` → `start.sh`, make executable. **If `MODE = granular`**, Edit the copied `start.sh` and remove the ` --dangerously-skip-permissions` argument from the `claude` invocation (leave the rest of the line intact). In `MODE = bypass`, leave `start.sh` unchanged.
   - **If `MODE = granular`**, also write `<bot-dir>/.claude/settings.json` with a broad allow list that matches bypass behavior without the startup modal:
     ```json
     {
       "permissions": {
         "allow": [
           "Bash(*)",
           "Read(**)",
           "Write(**)",
           "Edit(**)",
           "Glob(**)",
           "Grep(**)",
           "WebFetch(*)",
           "WebSearch(*)"
         ]
       }
     }
     ```
     Tell the user where this file lives and that they can tighten/expand it later. Skip this file entirely in `MODE = bypass` — it's not needed when `--dangerously-skip-permissions` is on.
   - Create `memory/MEMORY.md` (empty memory index).
   - Create `journal/` directory.
   - **Install meta-skills**: the hardcoded meta-skill list is `["evolve", "llm-wiki", "learn"]` — must match `upgrade-meta-skill/SKILL.md`'s list verbatim. For each name, copy `$CLAUDE_PLUGIN_ROOT/skills/<name>/` → `<bot-dir>/.claude/skills/<name>/` (mkdir -p as needed), **excluding `node_modules/`** (not portable across machines). If the copied skill has a `package.json`, run `npm install --omit=optional` inside `<bot-dir>/.claude/skills/<name>/` and record any failures so you can surface them at the end of this step. Heartbeat and sleep are NOT in this list — they're not skills; they're cron-driven task lists (`HEARTBEAT.md` / `SLEEP.md`) wired up by `CLAUDE.md` → "Heartbeat and Sleep".
   - **Initialize self-skills registry**: `touch <bot-dir>/.claude/skills/.self-skills` (plain text file, newline-separated skill names). Starts empty. This registry is where `evolve` appends new self-created skills; plugin-provided skills like `evolve` itself are NOT listed here.
   - Initialize git repo. Make sure `memory/`, `journal/`, `USER.md`, and `.claude/skills/` are tracked.
     - **Before the first commit**, check git identity is configured, or `git commit` fails with `Author identity unknown`. Run `git config --global user.email` and `git config --global user.name`; if either is empty (non-zero exit or empty output), set **repo-local** identity in `<bot-dir>`:
       ```bash
       git config user.name "<preferred name from USER.md, or 'Bot Owner' as fallback>"
       git config user.email "<user email if known, else '<preferred-name>@zero-claw.local'>"
       ```
       Do NOT touch `--global` — don't pollute the user's other repos.
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
    - **Watch the pane until the bot is ready** — use `tmux capture-pane -t <name> -p` in a short polling loop (every ~2s, up to ~30s). Target the **session** only (no `:0.0` / `:1.1` suffix) — the user may have `base-index` / `pane-base-index` set to 1 in their `~/.tmux.conf`, in which case `:0.0` doesn't exist. Bare `-t <session>` routes to the active window's active pane and works regardless. What you look for depends on `MODE` from step 9b:
      - **`MODE = bypass`**: there is a first-run permission prompt to handle, then the ready prompt.
        1. **Permission modal** — Claude Code under `--dangerously-skip-permissions` shows a confirmation on first launch (text like "Yes, I accept" / "No, exit"). If you see it, send `2` + Enter to accept:
           ```bash
           tmux send-keys -t <name> -l '2' && tmux send-keys -t <name> Enter
           ```
           Then keep polling.
        2. **Ready prompt** — input box visible, no modal. Once you see it, send `start` to trigger the SessionStart hook (registers heartbeat and cron tasks):
           ```bash
           tmux send-keys -t <name> -l 'start' && tmux send-keys -t <name> Enter
           ```
      - **`MODE = granular`**: no permission modal appears (we removed `--dangerously-skip-permissions` and pre-wrote `.claude/settings.json`). Just wait for the ready prompt and send `start` the same way.

      Do NOT just sleep 15s and blindly send "start" — in bypass mode the permission modal swallows the keystroke. Always verify the pane state by capture-pane before sending.
    - Tell the user: "Your bot is starting up. You can watch it with: `tmux attach -t <name>`"
    - **Verify the Supervisor bot is reachable — this is a hard gate.** Do NOT skip it, do NOT postpone it until after pairing, and do NOT bundle it with any other user-facing test. It gets its own round: one message asking for one thing, then wait.
      > "Open Telegram and DM **@<supervisor-bot-username>** with `/help` (or `/status`). Paste the reply back here so I can confirm the Supervisor bot is alive."

      While this is outstanding, say nothing about pairing `<AssistantName>` yet — the user will try to do both at once and you'll lose the ability to diagnose which channel is broken. Silence until they paste the Supervisor reply.

      When the user pastes the reply, check it looks like the Supervisor bot's menu (mentions `/status`, `/restart`, `/logs`, etc.). If nothing comes back, diagnose before continuing: `pm2 logs <dirname>-supervisor --lines 40`, check `ecosystem.config.cjs` token, check the user_id is in `ALLOWED_USERS`. Only once the Supervisor reply is confirmed, proceed to step 12.

12. **Pair Telegram** — **the pairing step waits for a HUMAN, not for the bot.** The bot sits silently waiting for a Telegram DM; there is no progress signal to poll. Do not background-poll the tmux pane.

    **One user action per message, always.** Each substep below is its own round — send one instruction, wait for the user's paste/confirmation, then move to the next. Never collapse "send hi to `<AssistantName>`" + "DM Supervisor /status" + "try another message" into a single checklist. Batching these hides which one failed when something breaks.

    1. Say to the user **explicitly**:
       > "Open Telegram and DM **@<main-bot-username>** with any message (e.g. 'hi'). The bot will reply with a 6-character pairing code. **Paste that code back here.** I'm waiting for you, not for the bot — until you paste the code, nothing will happen on my end."
    2. When the user pastes the code, **edit `<bot-dir>/.telegram/access.json` directly** — do NOT shell out to `/telegram:access` (it has the same hardcoded-path bug). Steps:
       - **Read the file first.** The Telegram plugin generated this file with its own field names; treat what's on disk as authoritative and keep the structure/casing you see.
       - **Field contract (verified against the plugin's server.ts):** `allowFrom` is an **array of user_id strings**, not objects. The plugin checks access with `access.allowFrom.includes(senderId)` where `senderId` is a string — pushing an object like `{userId, chatId, displayName}` silently fails to match. Examples:
         - ✅ `"allowFrom": ["5941854392"]`
         - ❌ `"allowFrom": [{"userId": "5941854392", "displayName": "Boss"}]`
       - Find the pending entry whose code matches the pasted one.
       - Append its `user_id` (as a string) to the `allowFrom` array. Drop the display name and chat id — they don't go into `allowFrom`.
       - Remove the matched entry from `pending`.
       - Optionally flip `dmPolicy` to `allowlist` once the user confirms no one else needs in.
    3. Ask the user to send **one more** Telegram message to `<AssistantName>` to confirm the bot now replies normally (pairing only proves the handshake, not that the bot's main loop is responsive). This is its own round — don't mention Supervisor here; that was already verified in step 11. Wait for the user to confirm they got a reply before moving on.
    4. Confirm: "Your assistant is live! Messages to @<main-bot-username> now reach it."
    5. Give a brief tour: memory system, heartbeat, Supervisor bot `/help`.
    6. Tell user: `tmux attach -t <name>` to watch, `Ctrl-b d` to detach.
