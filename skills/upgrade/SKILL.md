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

Use AskUserQuestion: "What language should we use? / 使用什么语言？"
- English
- 中文
- 日本語 (or another suggested language based on system locale)
- (Other — user types their own)

Continue the entire upgrade process in that language.

### Phase 1: Detect

**Key concept: project root vs bot directories.** These are DIFFERENT locations:

```
project-root/                 ← "parent" — where you run the upgrade
├── ecosystem.config.cjs      ← supervisor config lives HERE
├── supervisor/               ← supervisor code lives HERE
├── bot-a/                    ← bot directory (child)
│   ├── CLAUDE.md
│   ├── start.sh
│   ├── memory/
│   └── journal/
└── bot-b/                    ← another bot directory (child)
```

**The current working directory IS the project root.** Supervisor and ecosystem.config.cjs belong here, NOT inside any bot directory.

**Step 1a: Find project-root-level components** in the current directory:
- `ecosystem.config.cjs` — supervisor config
- `supervisor/` or `supervisor/index.mjs` — supervisor code

**Step 1b: Find bot directories.** These are subdirectories that contain `CLAUDE.md` + `start.sh`. Also check `ecosystem.config.cjs` BOTS entries for declared bot paths. A bot directory is identified by having CLAUDE.md — it is NEVER the same directory as the project root.

If neither ecosystem.config.cjs nor any bot directories are found, use AskUserQuestion to ask the user to confirm this is the right directory.

**Step 1c: Parse ecosystem.config.cjs** (if it exists) to discover:
- Supervisor bot token (present or not)
- BOTS entries → list of bot names, sessions, work dirs
- Any legacy env vars (TMUX_SESSION, WORK_DIR — pre-multi-bot format)

Confirm the detected layout with the user before proceeding:
```
Project root: /workspace/test_zero_claw2
Supervisor:   /workspace/test_zero_claw2/supervisor/
Bots found:   claude-bot → /workspace/test_zero_claw2/claude-bot/
```

### Phase 2: Diagnose all components

For each component, compare against the canonical version in `$CLAUDE_PLUGIN_ROOT` and classify as:

- **Up to date** — matches or functionally equivalent → skip, no task needed
- **Outdated** — older version, missing features → needs upgrade task
- **Custom/unknown** — user-modified or hand-rolled → needs upgrade task with careful handling
- **Missing** — component doesn't exist yet → needs upgrade task

Components to check:

**a) Supervisor (`supervisor/index.mjs`)** — check for: multi-bot support, watchdog, /screen, /send, BOTS env parsing. Check `supervisor/package.json` dependencies.

**b) ecosystem.config.cjs** — check format: BOTS env var? Legacy single-bot vars? Missing env vars (WATCHDOG_INTERVAL, BOOT_DELAY)? Also check the pm2 app name: if it's just `supervisor` (generic), it should be renamed to `<assistant-name>-supervisor` to avoid collisions with other Zero-Claw projects on the same machine.

**b2) pm2 collision check** — run `pm2 jlist` and check if there's already a process named `supervisor` (or the same name). Compare its `cwd` with the current project root. If it belongs to a DIFFERENT project, warn the user and do NOT restart it. Only restart the supervisor that belongs to THIS project (matched by cwd).

**c) Bot CLAUDE.md** (for each bot) — check for key sections: Heartbeat, Memory System, Cron Tasks, Journal Format. **Do NOT compare personality/role/principles** — those are user customizations.

**d) start.sh** (for each bot) — check for: TELEGRAM_STATE_DIR export, --project-dir flag.

**e) Skills** — check if bot directories have:
- `.claude/skills/heartbeat/` (core autonomous skill)
- `.claude/skills/evolve/` (meta-skill — and any other meta-skills in the list; currently just `evolve`)
- `.claude/skills/.self-skills` (empty registry file — evolve writes to this when it creates a new skill)

For users who only want to refresh the meta-skill layer (not the whole infra), point them at `/zero-claw:upgrade-meta-skill` instead.

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

After applying: `cd supervisor && npm install`. For pm2 restart, use the project-specific name (see ecosystem.config.cjs), NOT a generic `pm2 restart supervisor`. Verify the pm2 process cwd matches this project before restarting.

**ecosystem.config.cjs** (if outdated):
- "Migrate to new format" — preserve tokens and user IDs, add BOTS env var
- "Show diff" — show old vs new config
- "Skip"

Preserve any custom env vars the user added. **Rename pm2 app name** from generic `supervisor` to `<dirname>-supervisor` (where `<dirname>` is the project root directory name, e.g. `my-project-supervisor`) if it's still the generic name. Run `pm2 jlist` to verify the new name doesn't collide. Warn the user that pm2 will see this as a new process — they may need to `pm2 delete supervisor && pm2 start ecosystem.config.cjs && pm2 save`.

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

**Skills** (if any of heartbeat / evolve / .self-skills are missing):
- "Install all missing skills" — copy each missing one from `$CLAUDE_PLUGIN_ROOT/skills/<name>/` to `.claude/skills/<name>/`, and `touch .claude/skills/.self-skills` if missing
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
