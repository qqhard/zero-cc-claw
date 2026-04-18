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

Zero-Claw has two skill categories plus one non-skill mechanism:

| Category | Examples | Who owns them | Handled by |
|---|---|---|---|
| User-invocable | `setup`, `add-bot`, `upgrade`, `migrate-from-openclaw`, `upgrade-meta-skill` | Plugin | Run from plugin host |
| **Meta-skills** | `evolve`, `llm-wiki`, `learn` | Plugin | Refreshed by **this skill** |
| Autonomous cron (not a skill) | `HEARTBEAT.md`, `SLEEP.md` | Per-bot file | Refreshed by `/zero-claw:upgrade` along with `CLAUDE.md` |

Meta-skills are plugin-provided tools the bot uses but cannot modify — they're third-party, with their own release cycle. `evolve` maintains the bot's self-skill library (add/edit/retire). `llm-wiki` maintains the user-chosen knowledge vault. `learn` runs Socratic learning sessions. They have zero overlap in scope.

Heartbeat and sleep are NOT skills — they're cron-driven task lists living in the bot root, wired up by `CLAUDE.md` → "Heartbeat and Sleep". This skill does not touch them.

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

When Zero-Claw adds a new meta-skill, update this list (one name per line). Heartbeat and sleep are NOT meta-skills — they're cron-driven task lists wired up via `CLAUDE.md`.

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

1. **Git pre-snapshot** (backup via git, never `.bak` files): in `<bot-dir>`, check it's a git repo (`git rev-parse --git-dir`); if not, `git init && git add -A && git commit -m "chore: init before meta-skill upgrade"`. If the working tree is dirty, commit it with `chore: pre-meta-skill-upgrade snapshot` so the user has a clean restore point. To undo, `git revert` or `git reset --hard <sha>`.
2. Copy the meta-skill folder from `$CLAUDE_PLUGIN_ROOT/skills/<name>/` to `<bot-dir>/.claude/skills/<name>/` (mkdir -p as needed). **Exclude `node_modules/`** when copying — it's not portable across machines.
3. If the copied skill has a `package.json`, run `npm install --omit=optional` inside `<bot-dir>/.claude/skills/<name>/`. Record the exit status for Phase 4.
4. Ensure `<bot-dir>/.claude/skills/.self-skills` exists (create empty if missing — this is the registry `evolve` writes to).
5. Commit the refreshed meta-skills with `chore: refresh meta-skills (<names>)` so the change is tracked and reversible.

Meta-skills have zero user customization, so refresh is safe and doesn't need confirmation.

## Phase 4 — Verify

Print a summary: `<bot-name>: refreshed <N> meta-skills` or `<bot-name>: already up-to-date`. If any `npm install` in Phase 3 failed, list the affected `<bot>/<skill>` pairs so the user can retry manually.

Then tell the user:

> Meta-skills refreshed. Restart each bot (supervisor `/restart` or `tmux send-keys`) so the new cron behavior and skill logic take effect.
