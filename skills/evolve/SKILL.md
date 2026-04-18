---
name: evolve
description: "Daily skill-library maintenance. Upgrades (adds/edits) skills when patterns emerge, retires skills unused for 90+ days. Triggered by the nightly sleep cron (`SLEEP.md`), or manually via 'evolve' / 'self-review'. Only touches `.claude/skills/` — memory, SOUL, and USER belong to other owners."
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

Daily skill-library maintenance. The one job: keep the set of self-skills aligned with what the bot actually does, without letting it bloat.

## Scope

`evolve` is about **skills and only skills**. Memory, SOUL, USER are owned elsewhere; don't touch them.

**Allowed to touch:**

- ✅ `.claude/skills/<name>/` — **only if** `<name>` is listed in `.claude/skills/.self-skills` (plain-text registry, one name per line).
- ✅ `.claude/skills/.self-skills` (the registry itself).

**Forbidden:**

- ❌ `SOUL.md` — user-driven, Agent writes only on explicit direction.
- ❌ `USER.md` — updated reactively by the main Agent when user shares profile info; never by evolve.
- ❌ `memory/*` — owned by the heartbeat cron (hourly captures, via `HEARTBEAT.md`) and sleep cron (nightly distillation, via `SLEEP.md`).
- ❌ `IDENTITY.md`, `CLAUDE.md` — framework definitions, user-driven.
- ❌ `journal/*` — raw facts, never rewrite.
- ❌ Any skill **not** in `.self-skills` (plugin-provided skills are third-party — never modify).

If `.claude/skills/.self-skills` does not exist, create it as an empty file.

## Philosophy: two phases

- **Upgrade — fast, signal-triggered.** Create or edit a self-skill when a pattern recurs. "Add" and "edit" are the same force: the library grows more useful. No signal → no change.
- **Retire — slow, usage-triggered.** Delete skills that haven't been used in 90 days. Anti-entropy pressure on the library.

## Inputs

Read these before deciding anything:

1. Today's journal: `journal/$(date +%Y-%m-%d).md`
2. Last 7 days of journals (for upgrade signals): `journal/*.md`
3. Last 90 days of journals (for retire signals): same glob, wider window.
4. Reverted evolve commits: `git log --grep='^Revert.*evolve(' --since=30.days.ago` — for each, read the reverted diff and note the file + section to avoid.
5. Current self-skills: `cat .claude/skills/.self-skills`.

## Phase A — Upgrade (conditional, no budget)

**When to act** (any of the following is enough):

- Today's or recent journals contain `(candidate-skill: <slug>)` annotations — these are in-the-moment recognitions by the main Agent that a task could become a reusable skill. Read the surrounding entries to see what the flow looked like.
- A request pattern appears in journals ≥3 times in the last 7 days with no matching skill (or the existing one doesn't actually cover the real case).
- The user corrects the same behavior ≥2 times in recent journals.

**What to write**:

- **New self-skill**: name it for the pattern; draft a SKILL.md that is *minimal and specific* — solving exactly the cases you saw, not the cases you imagine. Include a concrete `description` with trigger phrases. Append the name to `.claude/skills/.self-skills`.
- **Edit an existing self-skill**: tighten it to actually cover the case that keeps slipping through, or replace an outdated section. Prefer editing over creating when a related skill exists.

The bot benefits from small, focused skills. When in doubt about whether to split or merge, prefer the version closer to the concrete case.

**What not to do**:

- Don't invent patterns that only happened once.
- Don't pre-generalize for hypothetical cases.
- Don't touch anything outside the Scope section.

If in doubt, skip this phase — there's always tomorrow.

## Phase B — Retire (always)

Scan `.self-skills`. For each registered skill, count its appearances in journal `(skills: ...)` tags over the last 90 days.

- **0 appearances in 90 days** → delete the folder, drop the name from `.self-skills`.
- **Non-zero but low** → leave alone. 90-day zero-use is the hard line; low-use skills still earn their place.
- **Grace period**: skills added in the last 90 days are exempt (check creation date via `git log --diff-filter=A --follow <skill path>`).

The goal is anti-entropy, not aggressive pruning. A skill unused for 90 days is either wrong, obsolete, or replaced — in none of those cases is keeping it helpful.

## Revert learning (stateless)

Before writing anything:

```bash
git log --grep='^Revert.*evolve(' --since=30.days.ago --format='%H'
```

For each revert commit hash, run `git show <hash>` to see what was undone, then skip any proposed change that would repeat that modification (same file + same region). Source of truth is git history — no separate state file.

## Commit protocol

If any phase produced a change, stage and commit everything in a single commit with this message:

```
evolve(YYYY-MM-DD): <one-line summary>

upgrade: <what was added or edited, or "none">  (evidence: <journal refs or commit hashes>)
retire:  <what was removed, or "none">          (reason: "90d no usage" or other)
```

If both phases produced zero changes → **do not commit**. Silent no-op is the correct outcome on a quiet day.

## Safety invariants

- Never run `git push`. The user's local git is the audit trail.
- Never touch forbidden paths (see Scope).
- Never retire a skill added less than 90 days ago.
- If uncertain whether a proposed change is safe, skip it — there's always tomorrow.
