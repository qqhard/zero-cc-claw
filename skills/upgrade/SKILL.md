---
name: upgrade
description: "Upgrade an existing Zero-Claw (or compatible) project to the latest version. Detects current state, diffs components, and selectively applies updates. Triggers: 'upgrade', 'update zero-claw', 'upgrade bot'."
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

# Zero-Claw Upgrade

Upgrade an existing project to the latest Zero-Claw version. Old setups may be hand-rolled, partially configured, or from earlier versions — diagnose before touching anything.

Plugin root is available as `$CLAUDE_PLUGIN_ROOT`. The canonical latest versions of all components live there.

## UX Rules — CRITICAL

**STOP-AND-WAIT**: After each AskUserQuestion call, you MUST stop and wait for the user's response before doing anything else. Do NOT proceed to the next component, do NOT present the next question, do NOT summarize upcoming work. Just stop.

**ONE question per message**: Each message you send may contain AT MOST one AskUserQuestion. Never call AskUserQuestion multiple times in one response.

**NEVER batch decisions**: Do NOT list all components and their options in a single message. Do NOT present an "upgrade plan" with all components at once. Do NOT ask "should I proceed with all of these?" Process each component as a separate conversation turn.

**Flow per component**:
1. Brief explanation of what's different (2-3 lines max)
2. AskUserQuestion with options for THIS component only
3. STOP. Wait for user response.
4. Apply the user's choice (backup first)
5. Move to next component — go to step 1

**TaskCreate per component**: each upgradeable component gets its own task for progress tracking.

**Backup before modify**: copy to `<file>.bak.<timestamp>` before any change.

## Steps

### Phase 0: Language

Use AskUserQuestion to ask the user's preferred language. Continue the entire upgrade process in that language.

### Phase 1: Detect

Find the project root. Look for these signals in the current directory and parents:

- `ecosystem.config.cjs` — supervisor config
- `supervisor/` or `supervisor/index.mjs` — supervisor code
- Bot directories containing `CLAUDE.md` + `start.sh`
- `.claude/` or `memory/` or `journal/` directories

If nothing is found, use AskUserQuestion to ask the user to point to their project directory.

Parse `ecosystem.config.cjs` (or equivalent) to discover:
- Supervisor bot token (present or not)
- BOTS entries → list of bot names, sessions, work dirs
- Any legacy env vars (TMUX_SESSION, WORK_DIR — pre-multi-bot format)

### Phase 2: Diagnose all components

For each component, compare against the canonical version in `$CLAUDE_PLUGIN_ROOT` and classify as:

- **Up to date** — matches or functionally equivalent → skip, no task needed
- **Outdated** — older version, missing features → needs upgrade task
- **Custom/unknown** — user-modified or hand-rolled → needs upgrade task with careful handling
- **Missing** — component doesn't exist yet → needs upgrade task

Components to check:

**a) Supervisor (`supervisor/index.mjs`)** — check for: multi-bot support, watchdog, /screen, /send, BOTS env parsing. Check `supervisor/package.json` dependencies.

**b) ecosystem.config.cjs** — check format: BOTS env var? Legacy single-bot vars? Missing env vars (WATCHDOG_INTERVAL, BOOT_DELAY)?

**c) Bot CLAUDE.md** (for each bot) — check for key sections: Heartbeat, Memory System, Cron Tasks, Journal Format. **Do NOT compare personality/role/principles** — those are user customizations.

**d) start.sh** (for each bot) — check for: TELEGRAM_STATE_DIR export, --project-dir flag.

**e) Skills** — check if bot directories have `.claude/skills/heartbeat/`.

**f) Memory/Journal structure** — check if `memory/MEMORY.md`, `journal/`, `USER.md` exist.

After diagnosis, show a brief summary table of all components and their status (just name + status, no details). Example:

```
supervisor         needs update
ecosystem.config   needs update
bot/start.sh       needs update
bot/CLAUDE.md      ok
bot/skills         missing
```

Then say: "Let's go through each one." and immediately start Phase 3 with the first component. Do NOT describe what each upgrade involves here — that happens in Phase 3, one at a time.

### Phase 3: Upgrade each component

**IMPORTANT**: Create a TaskCreate for each component that needs upgrading. Only create tasks for components that are NOT up to date. Process them one at a time: TaskUpdate → `in_progress`, ask, apply, TaskUpdate → `completed`, then move to next.

For each component that needs upgrading, follow this pattern:

1. **TaskUpdate** → `in_progress`
2. **Explain** what's different (2-3 lines, concise)
3. **AskUserQuestion** with component-specific options (see below)
4. **Apply** the user's choice (backup first if modifying)
5. **TaskUpdate** → `completed`

#### Component-specific options:

**Supervisor** (if outdated/missing):
- "Replace with latest" — safe, no user customization in supervisor code
- "Show diff" — display key differences before deciding
- "Skip"

After applying: `cd supervisor && npm install`. If pm2 is running supervisor, `pm2 restart supervisor`.

**ecosystem.config.cjs** (if outdated):
- "Migrate to new format" — preserve tokens and user IDs, add BOTS env var
- "Show diff" — show old vs new config
- "Skip"

Preserve any custom env vars the user added.

**Bot CLAUDE.md** (if missing sections — this is the tricky one):
- "Add missing sections" — inject new sections (Heartbeat, Memory System, etc.) without touching existing content
- "Show what will be added" — display the sections to be injected
- "Skip"
- **NEVER overwrite the entire CLAUDE.md** — it contains personality and user customizations

Fill placeholders using info from USER.md or existing CLAUDE.md.

**start.sh** (if outdated):
- "Replace with latest" — it's a one-liner, safe to overwrite
- "Show diff"
- "Skip"

**Skills** (if missing):
- "Install heartbeat skill" — copy to `.claude/skills/heartbeat/`
- "Skip"

**Memory/Journal** (if missing):
- "Create structure" — create `memory/MEMORY.md`, `journal/`, `USER.md` (non-destructive, never overwrites existing files)
- "Skip"

### Phase 4: Verify

After all component tasks are done:

1. If supervisor was upgraded and managed by pm2: verify it starts cleanly
2. For each upgraded bot: check CLAUDE.md has no broken markdown, start.sh is executable
3. Summarize what was done (one line per component)
4. Remind user to restart bots: supervisor `/restart` or `tmux send-keys`
5. AskUserQuestion: "Keep backup files (.bak) or delete them?"
