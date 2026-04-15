---
name: evolve
description: "Daily self-evolution: add/modify skills and SOUL based on observed patterns, simplify one self-owned skill by one step, forget a few redundant memory entries. Triggered by heartbeat's last-of-day run, or manually via 'evolve' / 'self-review'."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Evolve

Autonomous daily self-compression. The bot evolves its own capabilities.

## Philosophy: three forces in opposition

- **生 (add) — fast, signal-triggered.** Create/modify skills and SOUL.md when patterns emerge. No signal → no change. No budget.
- **磨 (grind) — slow, time-triggered.** Every run, pick one self-owned skill and simplify one part of it. Budget: ≤20 lines diff.
- **忘 (forget) — slow, time-triggered.** Every run, prune a small number of redundant memory entries. Budget: `min(2 files, 5%)`.

The asymmetry — fast birth, slow simplification — creates a natural filter. Useful additions survive the grind; weak additions fade.

## Scope

**Allowed to touch:**

- ✅ `.claude/skills/<name>/` — **only if** `<name>` is listed in `.claude/skills/.self-skills` (plain-text registry, one name per line).
- ✅ `SOUL.md`
- ✅ `memory/*` (prune / compress / merge only)

**Forbidden:**

- ❌ `USER.md`, `IDENTITY.md`, `CLAUDE.md`
- ❌ `journal/*` — journals are raw facts, never rewrite history
- ❌ Any skill **not** in `.self-skills` (plugin-provided skills are third-party mature components — never modify)

If `.claude/skills/.self-skills` does not exist, create it as an empty file. Treat absence as "no self-skills yet", which means Phase B is skipped.

## Inputs

Read these before deciding anything:

1. Today's journal: `journal/$(date +%Y-%m-%d).md`
2. Last 7 days of journals: `journal/*.md` (recent)
3. Recent commits: `git log --since=7.days.ago --oneline`
4. Recent self-evolution: `git log --grep='^evolve(' --since=30.days.ago`
5. Reverted evolve commits: `git log --grep='^Revert.*evolve(' --since=30.days.ago` — for each, read the reverted diff and note the file + section to avoid.
6. Current `memory/` state: `ls memory/*.md` and read `memory/MEMORY.md`
7. Current self-skills: `cat .claude/skills/.self-skills` (may be empty / missing)

## Phase A — 生 (conditional, no budget)

Act freely **only** when signals are strong. If no signal matches, skip this phase entirely — do not fabricate work.

**Signal: new skill**

- Look for a request pattern repeated **≥3 times** across the last 7 days of journals, where no existing skill (plugin or self) already covers it.
- If found: draft a new skill folder `.claude/skills/<name>/SKILL.md` with minimal frontmatter (`name`, `description`, `user-invocable`, `allowed-tools`) and a body tight enough to just work.
- Append `<name>` to `.claude/skills/.self-skills` (create the file if missing).

**Signal: SOUL adjustment**

- Look for the **same** user correction repeated **≥2 times** in recent journals (e.g. "don't X", "stop doing Y", or the user visibly softening/hardening the bot's tone).
- If found: patch `SOUL.md` — usually by appending/editing a line under `## Notes from the User`, occasionally by refining a `## Core Truths` bullet. Keep the change small and in the user's own spirit.

## Phase B — 磨 (always, budget ≤20 lines)

Pick one self-owned skill and make one simplification. If `.self-skills` is empty, skip this phase.

**Selection**: round-robin over entries in `.self-skills`; prefer the skill whose file has the oldest last-modified timestamp AND wasn't the target of a recent `grind` commit (check `git log --grep='grind:.*<name>' --since=7.days.ago`).

**Audit procedure**: walk each section of the selected SKILL.md and ask "if I remove this, does the skill still fulfill its frontmatter `description`?"

Candidates for cutting:

- Redundant steps (same thing said twice)
- Stale guardrails — run `git blame` on the guardrail line; if the original failure mode clearly can't happen anymore, drop it
- Verbose examples (condense to one line or remove entirely)
- Unused `allowed-tools` entries (grep the body — if the tool isn't referenced, drop it)

**Constraints:**

- Cut **one thing**. Diff ≤ 20 lines.
- Frontmatter `description` must still cover the skill's original trigger scenarios after the cut.
- If after the cut the skill body has <15 lines of meaningful content and no unique logic → delete the skill folder entirely and remove its name from `.self-skills`. That is the retirement path.

## Phase C — 忘 (always, budget min(2, 5%))

Prune redundant memory entries.

**Budget**: `min(2, floor(0.05 * count(memory/*.md)))`, but always at least 0 (can be a no-op).

**Priority** (delete highest-priority first until budget exhausted):

1. Self-contradicting entries already superseded by a newer entry
2. Facts that have been promoted into `SOUL.md` or a self-skill (information already upgraded in form)
3. Entries older than 90 days with no recent reference in journals (`grep -l`)

After pruning, update `memory/MEMORY.md` so the index stays consistent.

## Revert learning (stateless)

Before writing anything in any phase:

```bash
git log --grep='^Revert.*evolve(' --since=30.days.ago --format='%H'
```

For each revert commit hash, run `git show <hash>` to see what was undone, then skip any proposed change that would repeat that modification (same file + same region). Source of truth is git history — no separate state file.

## Commit protocol

If any phase produced a change, stage and commit everything in a single commit with this message:

```
evolve(YYYY-MM-DD): <one-line summary>

add:    <skill/soul changes or "none">  (evidence: <journal refs or commit hashes>)
grind:  <what was simplified in which skill or "none">  (reasoning: <why still works>)
forget: <memory files pruned or "none">  (reason: <where info went>)
```

If all three phases produced zero changes → **do not commit**. Silent no-op is the correct outcome on a quiet day.

## Safety invariants

- Never run `git push`. The user's local git is the audit trail.
- Never touch forbidden paths (see Scope).
- Never exceed budgets in Phase B (20 lines) or Phase C (min(2, 5%)).
- If uncertain whether a proposed change is safe, skip it — there's always tomorrow.
