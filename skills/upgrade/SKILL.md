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

## UX Rules

Always present choices as numbered options. Show diffs or summaries before applying changes. Never overwrite user customizations without confirmation.

## Steps

**IMPORTANT — Create tasks first:**

- TaskCreate("Detect project layout")
- TaskCreate("Diagnose components")
- TaskCreate("Plan upgrades")
- TaskCreate("Apply upgrades")
- TaskCreate("Verify")

### 1. Detect project layout

Find the project root. Look for these signals in the current directory and parents:

- `ecosystem.config.cjs` — supervisor config
- `supervisor/` or `supervisor/index.mjs` — supervisor code
- Bot directories containing `CLAUDE.md` + `start.sh`
- `package.json` with zero-claw references
- `.claude/` or `memory/` or `journal/` directories

If nothing is found, ask the user to point to their project directory.

Parse `ecosystem.config.cjs` (or equivalent) to discover:
- Supervisor bot token (present or not)
- BOTS entries → list of bot names, sessions, work dirs
- Any legacy env vars (TMUX_SESSION, WORK_DIR — pre-multi-bot format)

Build a **project map**:
```
parent/
├── ecosystem.config.cjs   ✓/✗
├── supervisor/             ✓/✗  (version or "unknown")
├── bot-a/                  ✓    (has CLAUDE.md, start.sh, memory/, journal/)
├── bot-b/                  ✓
└── ...
```

### 2. Diagnose components

For each component, compare against the canonical version in `$CLAUDE_PLUGIN_ROOT` and classify as:

- **Up to date** — matches or functionally equivalent
- **Outdated** — older version, missing features
- **Custom/unknown** — user-modified or hand-rolled, can't auto-upgrade
- **Missing** — component doesn't exist yet

#### Components to check:

**a) Supervisor (`supervisor/index.mjs`)**
- Compare against `$CLAUDE_PLUGIN_ROOT/supervisor/index.mjs`
- Check for: multi-bot support, watchdog, /screen command, /send command, BOTS env parsing
- Check `supervisor/package.json` dependencies (telegraf version)

**b) ecosystem.config.cjs**
- Check format: does it use the BOTS env var? Legacy single-bot vars?
- Check for missing env vars (WATCHDOG_INTERVAL, BOOT_DELAY, etc.)

**c) Bot CLAUDE.md** (for each bot directory)
- Check for key sections: Heartbeat, Memory System, Cron Tasks, Journal Format
- Check heartbeat config: does it use CronCreate? Manual cron? No heartbeat at all?
- Check memory config: uses built-in auto-memory, custom memory/, or nothing?
- **Do NOT compare personality/role/principles** — those are user customizations

**d) start.sh** (for each bot)
- Check for: TELEGRAM_STATE_DIR export, --project-dir flag, --dangerously-skip-permissions
- Compare against `$CLAUDE_PLUGIN_ROOT/start.sh`

**e) Skills**
- Check if bot directories have `.claude/skills/` with heartbeat skill
- Compare against `$CLAUDE_PLUGIN_ROOT/skills/heartbeat/SKILL.md`

**f) Memory/Journal structure**
- Check if `memory/MEMORY.md`, `journal/` exist
- Check if USER.md exists

Present the diagnosis as a table:

```
Component          Status       Details
─────────────────────────────────────────
supervisor         outdated     missing /screen, /send commands
ecosystem.config   outdated     uses legacy single-bot format
thoth/CLAUDE.md    outdated     missing heartbeat section
thoth/start.sh     outdated     missing TELEGRAM_STATE_DIR
thoth/skills       missing      no heartbeat skill
thoth/memory       ok           memory/ and journal/ present
```

### 3. Plan upgrades

For each outdated or missing component, present upgrade options:

**Supervisor** (if outdated/missing):
- "Replace with latest" — overwrites `supervisor/index.mjs` entirely (safe because supervisor has no user customization)
- "Skip"

**ecosystem.config.cjs** (if outdated):
- "Migrate to new format" — preserve tokens and user IDs, restructure to BOTS format
- "Skip"

**Bot CLAUDE.md** (if outdated — this is the tricky one):
- Show exactly which sections are missing or outdated (e.g. "Missing: Heartbeat section, Memory System section")
- "Add missing sections" — inject new sections without touching existing content
- "Show diff" — display what would be added, let user approve line by line
- "Skip"
- **NEVER overwrite the entire CLAUDE.md** — it contains personality and user customizations

**start.sh** (if outdated):
- "Replace with latest" — it's a one-liner, safe to overwrite
- "Skip"

**Skills** (if missing):
- "Install heartbeat skill" — copy to `.claude/skills/heartbeat/`
- "Skip"

**Memory structure** (if missing):
- "Create memory/MEMORY.md and journal/" — non-destructive
- "Skip"

Ask the user to confirm the upgrade plan. Show everything that will change.

### 4. Apply upgrades

For each approved upgrade:

1. **Backup first**: Before modifying any file, copy it to `<file>.bak.<timestamp>`. Announce the backup path.
2. Apply the change
3. Mark task complete

Specific upgrade procedures:

**Supervisor replacement:**
```bash
cp -r $CLAUDE_PLUGIN_ROOT/supervisor/ supervisor/
cd supervisor && npm install
pm2 restart supervisor  # if running
```

**ecosystem.config.cjs migration:**
- Read old config, extract tokens, user IDs, bot paths
- Generate new format using BOTS env var
- Preserve any custom env vars the user added

**CLAUDE.md section injection:**
- Read the canonical template from `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md`
- Extract only the missing sections (Heartbeat, Memory System, etc.)
- Append or insert at appropriate locations in the existing file
- Fill in placeholders using info from USER.md or existing CLAUDE.md

**start.sh replacement:**
- Copy from `$CLAUDE_PLUGIN_ROOT/start.sh`, make executable

**Skills installation:**
- Create `.claude/skills/heartbeat/` in bot directory
- Copy SKILL.md from plugin root

### 5. Verify

After all upgrades:
1. If supervisor was upgraded and is managed by pm2: `pm2 restart supervisor`, check it starts cleanly
2. For each upgraded bot: check that CLAUDE.md parses correctly (no broken markdown), start.sh is executable
3. Summarize what was done
4. Remind user to restart their bots: `tmux send-keys -t <name>:0.0 '/exit' Enter` then re-run start.sh, or use supervisor `/restart`
5. Clean up .bak files? Ask user: "Keep backups or delete them?"
