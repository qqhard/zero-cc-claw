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

Meta-skills are plugin-provided tools the bot uses but cannot modify — they're third-party, with their own release cycle. `evolve` is a self-modification tool (it operates on the bot's self-skills, SOUL, memory). `llm-wiki` is a knowledge-management tool (it operates on a user-chosen vault). They have zero overlap in scope.

## Phase 0 — Language

Match the user's language for every reply, table caption, and status message. Detect in this order:

1. The language the user used to invoke the skill.
2. The `Language:` field in any bot's `USER.md` under the project root.
3. System locale.

Only ask (via AskUserQuestion: `"What language should we use? / 使用什么语言？"`) if detection is ambiguous. Don't re-ask on subsequent runs — this skill is meant to be fully automatic.

## Meta-skill list

**As of this version, the meta-skills are:**

```
evolve
llm-wiki
learn
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
2. Copy the meta-skill folder from `$CLAUDE_PLUGIN_ROOT/skills/<name>/` to `<bot-dir>/.claude/skills/<name>/` (mkdir -p as needed). **Exclude `node_modules/`** when copying — it's not portable across machines.
3. If the copied skill has a `package.json`, run `npm install --omit=optional` inside `<bot-dir>/.claude/skills/<name>/`. Record the exit status for Phase 4.
4. Ensure `<bot-dir>/.claude/skills/.self-skills` exists (create empty if missing — this is the registry `evolve` writes to).

Meta-skills have zero user customization, so refresh is safe and doesn't need confirmation.

## Phase 4 — Verify

Print a summary: `<bot-name>: refreshed <N> meta-skills` or `<bot-name>: already up-to-date`. If any `npm install` in Phase 3 failed, list the affected `<bot>/<skill>` pairs so the user can retry manually.

Then tell the user:

> Meta-skills refreshed. Restart each bot (supervisor `/restart` or `tmux send-keys`) so the new cron behavior and skill logic take effect.
