---
name: migrate-from-openclaw
description: "Migrate an existing OpenClaw workspace into a Zero-Claw layout. One-shot setup replacement that preserves agents, personas, memory, skills, scripts, and MCPs. Triggers: 'migrate from openclaw', 'import openclaw', 'switch from openclaw to zero-claw'."
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

# Migrate from OpenClaw

One-shot migration from an OpenClaw workspace to a Zero-Claw layout. Replaces `/zero-claw:setup` when the user already has agents running under OpenClaw — no re-naming, no re-shaping personas, no losing memory.

**What changes vs. fresh setup:**
- No persona-shaping questions — take everything from OpenClaw's `IDENTITY.md` / `SOUL.md` / `USER.md` (zero-claw merges them into a single `SOUL.md` on the target side).
- Bot tokens are read out of the user's `openclaw.json` — no BotFather round-trip for agents.
- Memory / journal / skills / scripts / MCPs are migrated in place.
- The only BotFather step is for the **supervisor** bot (OpenClaw has no supervisor concept).

Plugin root is available as `$CLAUDE_PLUGIN_ROOT`.

## UX Rules

Same as `/zero-claw:setup` — numbered options via AskUserQuestion wherever possible, paste fields when the value is free-form. Continue in the user's chosen language.

## Steps

**IMPORTANT — Create tasks first:**

- TaskCreate("Choose language")
- TaskCreate("Check prerequisites (tmux, node, pm2, bun)")
- TaskCreate("Check Telegram plugin")
- TaskCreate("Locate OpenClaw source (workspace + openclaw.json)")
- TaskCreate("Discover agents and confirm migration list")
- TaskCreate("Create supervisor bot (BotFather)")
- TaskCreate("Choose target parent directory")
- TaskCreate("Generate files per agent")
- TaskCreate("Migrate MCP configs")
- TaskCreate("Launch bots & pair Telegram")

1. **Language** — same as setup step 1.

2. **Prerequisites** — same as setup step 2 (tmux / node / pm2 / bun).

3. **Telegram plugin** — same as setup step 3.

4. **Locate OpenClaw source**:

   a. Ask for the **OpenClaw workspace directory** (the one containing root-level `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, plus `memory/`, `skills/`, `scripts/`, `config/`). Default suggestion: `~/.openclaw/workspace`.

   b. Ask for the **openclaw.json path** (holds the Telegram tokens). Default: `~/.openclaw/openclaw.json`. Parse it and extract `channels.telegram.accounts` — a map of `<account-id> → { token, ... }`. Keep this in working state.

   c. Validate: workspace exists, `AGENTS.md` + at least one of `IDENTITY.md`/`SOUL.md`/`USER.md` exists, `openclaw.json` parses as JSON. If any check fails, ask the user to fix the path and retry.

5. **Discover agents**:

   - **Primary agent**: the workspace root itself. Name = `IDENTITY.md` `Name:` field (fallback to the assistant name mentioned in `SOUL.md`, then prompt).
   - **Additional agents**: each subdirectory of `config/agent-backups/*/` that has its own `IDENTITY.md` + `SOUL.md`.

   Show the full list with AskUserQuestion (multiSelect): "Which agents to migrate?" — default all selected. For each selected agent, try to auto-match it to an account ID in `openclaw.json` by name (case-insensitive). If no match, show the available account IDs and ask the user which Telegram token belongs to this agent.

   Confirm the pairing back to the user: `<agent-name> → <masked-token> (@<bot-username>)` per agent. Username is discoverable via `https://api.telegram.org/bot<token>/getMe` if the user wants confirmation; otherwise skip.

6. **Supervisor bot** — detect first, create only if missing:

   a. First, ask the user for the target parent directory (preview of step 8) so we know where to check. Default to current working directory.

   b. Look for `<parent>/ecosystem.config.cjs`. If it exists, parse it and read `SUPERVISOR_BOT_TOKEN` from the `env` block. Also check `<parent>/supervisor/` exists and `pm2 describe <parent-dirname>-supervisor` returns a running process.

   c. Decision tree:
      - **All three present** (`ecosystem.config.cjs` + valid token + pm2 running): reuse the existing supervisor. Show the user: "Found existing supervisor `<parent-dirname>-supervisor` on pm2 — will reuse it and append migrated bots to its `BOTS` list." Skip BotFather; skip writing `supervisor/` or `ecosystem.config.cjs` from scratch in step 9.
      - **`ecosystem.config.cjs` present but token empty or pm2 not running**: tell the user what's wrong (token missing / pm2 not started) and offer: "1. Fix it — paste the supervisor token / start pm2 — and re-detect  2. Create a fresh supervisor via BotFather".
      - **Nothing present**: OpenClaw has no supervisor concept, so guide the user through BotFather to create one named `<Primary-Agent> Supervisor` / `<primary>_supervisor_bot`. Collect the token. Same skip/resume behavior as setup.

   d. Remember the decision (reuse vs. create) for step 9 — if reusing, step 9n (copy `supervisor/`) and step 9o (generate `ecosystem.config.cjs`) become "append BOTS entries to the existing file" instead.

7. **Collect user info** — reuse whatever is already in the OpenClaw root `USER.md`:
   - Parse name / "what to call them" / timezone / user_id fields.
   - If the Telegram user_id is missing from `USER.md`, ask for it (link to @userinfobot, same as setup step 7).
   - Show the parsed USER.md back and ask "1. Use as-is  2. Edit something".

8. **Choose target parent directory**: same UX as setup step 9. Default to current working directory. Each agent will become `<parent>/<agent-name-lowercase>/`, supervisor goes to `<parent>/supervisor/`.

9. **Generate files** — the core migration. Do these in order, per agent:

   Per-agent (in `<parent>/<agent-name>/`):

   a+b. **SOUL.md** (merged) — zero-claw no longer has a separate `IDENTITY.md`. Read OpenClaw's `IDENTITY.md` and `SOUL.md`, then write a single `<bot-dir>/SOUL.md` in this shape:
      - Header bullets — `Name`, `Creature`, `Vibe`, `Emoji`, `Avatar` (from OpenClaw's `IDENTITY.md`). If that file has unfilled placeholders because the agent came from `config/agent-backups/<name>/`, fall back to extracting name/creature/vibe from their `SOUL.md` and prompt the user only for missing bits.
      - `## Core Responsibility` — one to three sentences from the OpenClaw SOUL's "你是 X" assertion or the `## 核心职责` / `## Core Responsibility` section (summarize if it's a list).
      - `## Core Truths` — the personality/style body from OpenClaw's `SOUL.md` (`## 风格` / `## Style` / equivalent). Keep it substantive; these are the agent's actual voice, not the baseline zero-claw bullets.
      - `## Boundaries` — OpenClaw's `## 不做的事` / `## Boundaries` section.
      - `## Notes from the User` — any free-form remainder the user had; leave a placeholder invite if OpenClaw had nothing there.

   c. **HEARTBEAT.md** — if OpenClaw has one (`HEARTBEAT.md` at root or in `config/agent-backups/<name>/`), copy it. Otherwise scaffold from `$CLAUDE_PLUGIN_ROOT/template/HEARTBEAT.md`.

   d. **USER.md** — for the **primary agent**, copy root `USER.md`. For additional agents, **symlink** to the primary's `USER.md` (single source of truth; mirrors add-bot's "symlink" option).

   e. **CLAUDE.md** — copy `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md` **verbatim**. It is system mechanism with no placeholders; identity / responsibility / personality all live in `SOUL.md` now. Keep this file byte-identical across all bots.

   f. **journal/** — rename OpenClaw's per-agent `memory/YYYY-MM-DD.md` daily logs into `journal/YYYY-MM-DD.md`. For the primary agent use the root `memory/*.md` daily files; for backed-up agents use whatever daily files exist under their backup dir (usually none — they live at the root).

   g. **MEMORY.md → memory/** — take OpenClaw's root `MEMORY.md` and split by H2 sections (each `## <topic>` becomes `memory/<slugified-topic>.md`). Then write `memory/MEMORY.md` as an index: for each topic file, one bullet `- [<Title>](<file.md>) — <first paragraph one-liner>`. Keep the index under 200 lines. If parsing is ambiguous, err on the side of fewer / larger topic files rather than over-splitting.

   h. **Skills** — copy `<openclaw-workspace>/skills/` → `<bot-dir>/.claude/skills/`.

   i. **Scripts** — copy `<openclaw-workspace>/scripts/` → `<bot-dir>/scripts/`. Run `chmod +x` on `.sh` files.

   j. **TOOLS.md** — do **not** create a `TOOLS.md` in zero-claw. Instead:
      - For each entry in OpenClaw's `TOOLS.md` that describes a tool category (cameras, SSH, TTS, speakers, devices), ask the user whether to:
        1. Convert it to a dedicated skill (give it a name — e.g. `cameras`, `ssh-hosts`, `tts` — and scaffold a `.claude/skills/<name>/SKILL.md` that records the entries as data).
        2. Drop it into `memory/tools-notes.md` as a reference-only record, and add an index entry pointing to it.
      - Either way, preserve the raw content somewhere — nothing from TOOLS.md is lost.

   k. **MCP configs** — read `<openclaw-workspace>/config/mcporter.json`. For each server in `mcpServers`:
      - Translate to Claude Code's `.mcp.json` format (server entry with `command` + `args` + `env`).
      - Rewrite any absolute paths pointing at `<openclaw-workspace>/config/...` to use the new location (`<bot-dir>/config/...`).
      - Copy the referenced credential files (typically `config/google-auth/*`) from OpenClaw workspace → `<bot-dir>/config/google-auth/`.
      - Write to `<bot-dir>/.mcp.json`.

   l. **start.sh** — copy `$CLAUDE_PLUGIN_ROOT/start.sh` → `<bot-dir>/start.sh`, `chmod +x`.

   m. **Initialize git** in each bot dir. Track `CLAUDE.md`, `SOUL.md`, `USER.md`, `HEARTBEAT.md`, `memory/`, `journal/`, `skills/` under `.claude/`, `scripts/`. Git-ignore `.telegram/` and `config/google-auth/` (they hold secrets).

   Parent dir (`<parent>/`):

   n. **supervisor/** — skip if reusing an existing supervisor (step 6 detected one). Otherwise copy `$CLAUDE_PLUGIN_ROOT/supervisor/` → `supervisor/`, run `npm install`.

   o. **ecosystem.config.cjs**:
      - If reusing: parse the existing file, append the migrated agents to the `BOTS` env string (comma-separated `<name>:<name>:<bot-dir>` entries), preserve everything else, write back. Then `pm2 restart <parent-dirname>-supervisor` so the new `BOTS` takes effect.
      - If creating new: generate with supervisor token, user_id, and `BOTS` covering every migrated agent. pm2 app name = `<parent-dirname>-supervisor` (same collision check as setup). `pm2 start ecosystem.config.cjs && pm2 save`.

10. **Launch bots & pair**:

    a. Supervisor:
       - If reusing an existing supervisor: already handled in step 9o via `pm2 restart`. Skip.
       - If created new in this migration: `pm2 start ecosystem.config.cjs && pm2 save` (also already run in step 9o — this is a sanity check).

    b. For each migrated agent, in order:
       - Write the Telegram token directly (same approach as add-bot step 8b — do NOT use `/telegram:configure` send-keys):
         ```bash
         mkdir -p <bot-dir>/.telegram
         printf 'TELEGRAM_BOT_TOKEN=%s\n' "<agent-token-from-openclaw.json>" > <bot-dir>/.telegram/.env
         chmod 600 <bot-dir>/.telegram/.env
         ```
       - Start the bot: `tmux new-session -d -s <name> -c <bot-dir> './start.sh'`, wait ~15s, send `start` + Enter to fire SessionStart.
       - Tell the user: "Open Telegram and DM **@<bot-username>**. It'll reply with a 6-char pairing code — paste that back here."
       - When they paste the code, edit `<bot-dir>/.telegram/access.json` directly (same mechanism as add-bot step 8d) to move their user_id from `pending` to `allowed`.
       - Confirm: ask user to send "hi" to the bot and verify it replies with the expected persona.

    c. After all agents paired, show a summary: list each `<name> → @<bot-username>` plus `tmux attach -t <name>` hint, and tell the user to supervise via the supervisor bot.

## Safety / Idempotency

- If `<bot-dir>` already exists with any content, **stop** and ask the user whether to: overwrite / merge / pick a different name. Never silently clobber.
- If the source OpenClaw workspace is still in active use (daemon running), warn the user to stop it first — both can't own the same Telegram token.
- After migration succeeds, do NOT delete the OpenClaw workspace. Tell the user they can clean it up manually once they've verified the new setup works.
- If anything fails midway, the user can re-run this skill — detect partially-migrated bots and resume (same spirit as setup's `.zero-claw-setup.json` resume).

## Post-migration notes to show the user

- "Your OpenClaw workspace is untouched — delete it manually once you're confident."
- "Heartbeats are driven by `HEARTBEAT.md` in each bot dir. Edit that file to change what the agent checks."
- "MCP servers are configured in `<bot-dir>/.mcp.json`. Run `claude mcp list` inside a bot dir to verify."
- "Long-term memory was split by topic into `memory/*.md`. The index is `memory/MEMORY.md`."
