---
name: add-bot
description: "Create an additional bot/agent under the same parent directory. Triggers: 'add bot', 'new agent', 'create another bot', 'add-bot'."
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

# Add Bot

Create a new bot/agent alongside existing ones. Each bot has its own CLAUDE.md, memory, journal, and Telegram bot.

Plugin root is available as `$CLAUDE_PLUGIN_ROOT`.

## UX Rules

Always present choices as numbered options for the selection bar.

## Steps

**IMPORTANT — Create tasks first:**

- TaskCreate("Choose language")
- TaskCreate("Detect parent directory")
- TaskCreate("Create Telegram bot")
- TaskCreate("Name the new agent")
- TaskCreate("Shape agent persona (role, personality, notes)")
- TaskCreate("Generate files")
- TaskCreate("Register with supervisor")
- TaskCreate("Launch and pair")

1. **Language**: Use AskUserQuestion: "What language should we use? / 使用什么语言？"
   - English
   - 中文
   - (a third suggested language based on system locale, e.g. 日本語)
   - Other — type your own

   Continue the wizard in that language.

2. **Detect parent directory**: Look for `ecosystem.config.cjs` in the current directory or parent. If not found, ask the user where their bots live (the directory containing `supervisor/` and `ecosystem.config.cjs`).

3. **Create Telegram bot**: Guide the user to create a new bot via @BotFather for this agent. Parse the token from the pasted BotFather response.

4. **Name the new agent**: Suggest 3-5 mythology/folklore names (different from existing sibling bots — check parent's `ecosystem.config.cjs` to avoid duplicates). Give a one-line reason for each. Let the user pick or type their own.

5. **Shape the persona**: Same ONE-round, five-tab flow as `/zero-claw:setup` step 5. Single AskUserQuestion call with five orthogonal tabs — role / speaking style / thinking style / execution habits / anything else. Always include "Other — type your own" on each tab. Bias the role options toward specialists since this is a sibling bot:

   a. **Role** — "What's this agent mainly for?"
      - Research & knowledge companion
      - Writing & editing partner
      - Coding & engineering sidekick
      - Productivity & task manager
      - General life assistant
      - Other (type your own)

   b. **Speaking style** — tone options same as setup step 5b (warm / formal / playful / calm / blunt / other).

   c. **Thinking style** — reasoning options same as setup step 5c (systematic / intuitive / skeptical / exploratory / pragmatic / other).

   d. **Execution habits** — rhythm options same as setup step 5d (one-at-a-time / batch / proceed-on-assumptions / confirm-first / move-fast / other).

   e. **Anything else** — free-form additions. First option: `Skip (leave blank)`. Then 2-3 concrete prompts, plus "Other".

   **Derive, don't ask** for the identity-card surface attributes — they're auto-filled into `SOUL.md`'s header bullets:
   - **Creature** — auto-pick from the name's cultural background.
   - **Vibe tags** — 2-3 adjectives auto-derived from the speaking + thinking answers.
   - **Emoji** — auto-pick one that fits the name or role.
   - **Avatar** — skip by default; only ask if the user volunteers a path or URL.

   Draft a 2-4 sentence Core Truths paragraph from the five answers + the name's cultural background. Write everything straight into `SOUL.md` in step 6 — no separate "confirm paragraph" round. `CLAUDE.md` gets no customization.

6. **Generate files** in `<parent>/<agent-name-lowercase>/`:

   **Language policy (applies to every file below EXCEPT `CLAUDE.md`):** templates ship in English as a baseline. If the user chose a language other than English in step 1, translate the prose into that language as you write each file. `CLAUDE.md` is the one exception — system mechanism, copied verbatim and kept in English across all bots. Keep file/directory names, frontmatter keys (`name`, `description`, `type`, `allowed-tools`, `user-invocable`), frontmatter `type` values, journal tag syntax (`(skills: ...)`, `(candidate-skill: ...)`), cron expressions, shell commands, URLs, and skill names/slugs in English. Section headings can be translated.

   - Copy `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md` → `CLAUDE.md` **verbatim**. Do NOT fill placeholders and do NOT translate — no placeholders exist anymore; it's the system mechanism, identical across all bots.
   - Copy `$CLAUDE_PLUGIN_ROOT/template/SOUL.md` → `SOUL.md` and fill it in from the step 5 answers, in the user's language:
     - Header bullets — name, creature (auto-picked), vibe (auto-derived), emoji (auto-picked), avatar (leave blank if not provided).
     - `## Core Responsibility` — paragraph from step 5a.
     - `## Core Truths` — replace the personality paragraph placeholder with the drafted personality (speaking + thinking + execution woven together); translate the baseline bullet principles.
     - `## Boundaries` — translate the baseline bullets.
     - `## Notes from the User` — drop in step 5e free-form extras if any; otherwise leave the placeholder (translated) as an invite.
   - Copy `$CLAUDE_PLUGIN_ROOT/template/HEARTBEAT.md` → `HEARTBEAT.md`, translating the body into the user's language (the bot edits this live hourly task list over time, so it must start in their language).
   - Copy `$CLAUDE_PLUGIN_ROOT/template/SLEEP.md` → `SLEEP.md`, translating the body into the user's language. Same rationale as HEARTBEAT.md.
   - Copy `$CLAUDE_PLUGIN_ROOT/template/CRONTAB.md` → `CRONTAB.md`, translating the body into the user's language. Empty table by default.
   - **USER.md** — ask the user via AskUserQuestion: "How should USER.md be shared with the sibling bot?"
     1. **Copy** (default, safer) — independent file; edits to one bot won't leak into the other.
     2. **Symlink** — single source of truth; both bots see the same file. Pick this only if you want changes to propagate.
   - Copy `$CLAUDE_PLUGIN_ROOT/start.sh` → `start.sh`, make executable. **Verify** the copied file does NOT contain `--project-dir` (older versions had this invalid flag).
   - Create `memory/MEMORY.md`, `journal/`.
   - **Install meta-skills**: the hardcoded meta-skill list is `["evolve"]`. For each name, copy `$CLAUDE_PLUGIN_ROOT/skills/<name>/` → `<bot-dir>/.claude/skills/<name>/` (mkdir -p as needed). Heartbeat and sleep are not skills — their mechanism lives in `CLAUDE.md`, their task lists in `HEARTBEAT.md` / `SLEEP.md`.
   - **Initialize self-skills registry**: `touch <bot-dir>/.claude/skills/.self-skills` (empty, newline-separated). This is where `evolve` appends bot-created skills.
   - Initialize git repo.

7. **Register with supervisor**: Add the new bot to the parent's `ecosystem.config.cjs` — append to the `BOTS` env string as `<name>:<name>:<bot-dir>` (comma-separated). Then:
   - **Detect the supervisor's pm2 app name** — read the `name:` field from `ecosystem.config.cjs` (it should be `<dirname>-supervisor`). Run `pm2 describe <name>` to check it's actually registered.
   - If `pm2 describe` exits non-zero (not registered), tell the user: *"The supervisor isn't running under pm2 yet. Start it with `pm2 start ecosystem.config.cjs && pm2 save` from `<parent-dir>`, or run it under tmux directly."* — do NOT try `pm2 restart` blindly; it will silently no-op against a different project's supervisor.
   - If registered, run `pm2 restart <name> --update-env` so the new `BOTS` entry takes effect. **WARNING**: plain `pm2 restart <name>` silently reuses the env snapshot cached at first start — the supervisor will keep seeing the old `BOTS` and `/status` will never show the new bot. `--update-env` is required to re-read the `env:` block from `ecosystem.config.cjs`.

8. **Launch and pair** — **read this carefully: the pairing step waits for a HUMAN, not for the bot.** The bot will sit silently waiting for the user to DM it; there is no progress signal to poll, so do not background-poll the tmux pane.

   a. **Start the bot in background**:
      ```bash
      tmux new-session -d -s <name> -c <bot-dir> './start.sh'
      ```
      Wait ~15s for Claude Code to finish booting, then send `start` to fire the SessionStart hook. Target the **session** only — no `:0.0` / `:1.1` suffix — so it works whether or not the user has `base-index` / `pane-base-index` set in `~/.tmux.conf`:
      ```bash
      tmux send-keys -t <name> -l 'start' && tmux send-keys -t <name> Enter
      ```

   b. **Write the Telegram token directly** — do NOT use `/telegram:configure` via send-keys. That skill hardcodes `~/.claude/channels/telegram/.env` and ignores `TELEGRAM_STATE_DIR`, so it would clobber the sibling bot's global config and the new bot's server (which reads from `<bot-dir>/.telegram/`) would still see no token. Instead, write directly:
      ```bash
      mkdir -p <bot-dir>/.telegram
      printf 'TELEGRAM_BOT_TOKEN=%s\n' "<new-bot-token>" > <bot-dir>/.telegram/.env
      chmod 600 <bot-dir>/.telegram/.env
      ```
      The bot's `start.sh` exports `TELEGRAM_STATE_DIR="$(pwd)/.telegram"`, so the plugin server picks this up automatically. Restart the bot session so the new env is loaded:
      ```bash
      tmux send-keys -t <name> 'C-c' && sleep 1 && tmux send-keys -t <name> -l './start.sh' && tmux send-keys -t <name> Enter
      ```

   c. **Wait for the user to pair (NOT the bot)** — say to the user **explicitly**:
      > "Open Telegram and DM **@<new-bot-username>**. The bot will reply with a 6-character pairing code. **Paste that code back here.** I'm waiting for you, not for the bot — until you paste the code, nothing will happen on my end."
      Do not background-poll. Do not run `until grep ...; do sleep; done`. Just wait for the user's next message.

   d. **Approve the pairing by editing `access.json` directly** — also bypass `/telegram:access` (same hardcoded-path bug). When the user pastes the code, look it up and add their user_id to the allowlist:
      ```bash
      # Read pending pairings from <bot-dir>/.telegram/access.json
      # Find the entry matching the pasted code → grab its user_id and display name
      # Move that user into "allowed" and remove from "pending"
      # Optionally flip dmPolicy to "allowlist" once the user confirms nobody else needs in
      ```
      Use Read+Write on `<bot-dir>/.telegram/access.json` (don't shell-out to a non-existent skill).

   e. **Confirm success** — ask the user to send another message (e.g. "hi"). When they confirm the bot replied normally, you're done.

Show the user how to manage multiple bots:
- `tmux attach -t <name>` to watch any bot
- Supervisor `/status` shows all bots
- Each bot has independent memory and personality
