---
name: upgrade-meta-skill
description: "Refresh meta-skills (evolve, ...) in every bot directory under the current project. Meta-skills are self-modification tools installed by default; this keeps them in sync with the plugin. Non-destructive — user customizations in SOUL/CLAUDE/IDENTITY are never touched. Triggers: 'upgrade meta skill', 'refresh meta-skills', 'update evolve'."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - TaskCreate
  - TaskUpdate
---

# Upgrade Meta-Skill

Refresh the **meta-skill layer** across every bot in the project. Fully automatic — no per-bot prompting.

Plugin root is available as `$CLAUDE_PLUGIN_ROOT`.

## Skill taxonomy (for context)

Zero-Claw has three skill categories:

| Category | Examples | Who owns them | Handled by |
|---|---|---|---|
| User-invocable | `setup`, `add-bot`, `upgrade`, `migrate-from-openclaw`, `upgrade-meta-skill` | Plugin | Run from plugin host |
| Core autonomous | `heartbeat` | Plugin | Refreshed by `/zero-claw:upgrade` |
| **Meta-skills** | `evolve` | Plugin | Refreshed by **this skill** |

Meta-skills are the self-modification tools — they let the bot operate on its own skills and SOUL. `evolve` is the first. Future candidates: `reflect`, `teach`, `forget`, `clone`.

## Meta-skill list

**As of this version, the meta-skills are:**

```
evolve
```

When Zero-Claw adds a new meta-skill, update this list (one name per line).

## Phase 1 — Detect bot directories

The current working directory is the **project root** (contains `ecosystem.config.cjs` and/or `supervisor/`). Bot directories are **children** of the project root, each containing `CLAUDE.md` + `start.sh`.

Find bot directories two ways:

1. Parse `ecosystem.config.cjs` `BOTS` env var for declared bot paths.
2. Glob direct subdirectories with `CLAUDE.md` + `start.sh`.

Union the results. If no bots found, tell the user and stop.

## Phase 2 — Diff each bot against canonical

For each bot directory, for each meta-skill in the list above:

- Compare `<bot-dir>/.claude/skills/<name>/SKILL.md` against `$CLAUDE_PLUGIN_ROOT/skills/<name>/SKILL.md`.
- Classify: **up-to-date** / **outdated** / **missing**.

Print a compact table:

```
bot-a/evolve     outdated
bot-b/evolve     missing
bot-c/evolve     up-to-date
```

## Phase 3 — Apply (fully automatic)

No per-bot prompting. For every bot with any outdated/missing meta-skill:

1. Backup each existing `SKILL.md` to `SKILL.md.bak.$(date +%Y%m%d-%H%M%S)` before overwriting.
2. Copy the entire meta-skill folder from `$CLAUDE_PLUGIN_ROOT/skills/<name>/` to `<bot-dir>/.claude/skills/<name>/` (mkdir -p as needed).
3. Ensure `<bot-dir>/.claude/skills/.self-skills` exists (create empty if missing — this is the registry `evolve` writes to).

Meta-skills have zero user customization, so refresh is safe and doesn't need confirmation.

## Phase 4 — Verify

Print a summary: `<bot-name>: refreshed <N> meta-skills` or `<bot-name>: already up-to-date`.

Then tell the user:

> Meta-skills refreshed. Restart each bot (supervisor `/restart` or `tmux send-keys`) so the new cron behavior and skill logic take effect.
