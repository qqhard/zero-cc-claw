---
name: evolve
description: "Daily skill-library maintenance. Promotes a pattern to a new/edited self-skill when the abstraction is clean, retires skills unused for 90+ days. Triggered by the nightly sleep cron (`SLEEP.md`), or manually via 'evolve' / 'self-review'. Only touches `.claude/skills/` — memory, SOUL, and USER belong to other owners."
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

**Evolution is abstraction, not counting.** The question that gates every upgrade is "can I name a clean invariant?" — not "how many times did this happen?". A single well-abstracted pattern is worth more than five vaguely related incidents. Counting only shows up as a sanity check, never as the trigger.

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

- **Upgrade — abstraction-triggered.** Create or edit a self-skill when you can name a clean invariant from recent work. "Add" and "edit" are the same force: the library grows more useful. No nameable abstraction → no change.
- **Retire — usage-triggered.** Delete skills that haven't been used in 90 days. Anti-entropy pressure on the library.

Use the tools you already have — `Read`, `Grep`, `Glob`, `Bash` for `git log` — to gather whatever evidence the judgment needs. There is no pre-digested data layer; you decide what to look at.

## Phase A — Upgrade (abstraction check)

**Candidate sources** — any of these is enough to *consider* a candidate; none of them alone decides:

- `(candidate-skill: <slug>)` annotations in recent journals — in-the-moment recognitions by the main agent. Read the surrounding entries to see what the flow looked like.
- Patterns you notice while skimming the last 7 days of journals — recurring requests, recurring corrections, recurring shapes.
- The user correcting the same behavior multiple times — corrections are abstractions waiting to be named.

**Abstraction check** — both must hold before you write anything:

1. **Name the invariant in one sentence.** You can state the pattern as "when X, do Y" or "input-shape → output-shape". If the best you can write is "the user sometimes wants something like…", the abstraction isn't there yet — skip.
2. **Sanity check: ≥1 concrete occurrence in the last 7 days.** Not a threshold — a guard against inventing patterns from nothing. `(candidate-skill:)` tags already satisfy this.

A `(candidate-skill:)` tag short-circuits step 1 — the main agent already did the naming. Still confirm the invariant matches what the journal entries actually show before acting on it.

**What to write**:

- **New self-skill**: name it for the invariant; draft a SKILL.md that is *minimal and specific* — covering exactly the cases you saw, not the ones you imagine. Include a concrete `description` with trigger phrases. Append the name to `.claude/skills/.self-skills`.
- **Edit an existing self-skill**: tighten it to actually cover the case that keeps slipping through, or replace an outdated section. Prefer editing over creating when a related skill exists.

Prefer small, focused skills. When in doubt about whether to split or merge, pick the version closer to the concrete case. If the abstraction check is shaky, skip — there's always tomorrow.

## Phase B — Retire (usage-driven)

For each skill listed in `.claude/skills/.self-skills`:

1. Count `(skills: <name>)` tag occurrences in the last 90 days of journals.
2. Check creation date: `git log --diff-filter=A --follow <skill path>`. Skills younger than 90 days are in the grace period — leave alone.
3. If count is 0 **and** the skill is past its grace period → delete the folder, drop the name from `.self-skills`.
4. Non-zero usage → leave alone. 90-day zero-use is the hard line; low-use skills still earn their place.

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
- Stay within the paths listed in Scope above.
- If uncertain whether a proposed change is safe, skip it — there's always tomorrow.
