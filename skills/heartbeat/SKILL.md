---
name: heartbeat
description: "Periodic keep-alive, journaling, and memory/wiki maintenance. Called by CronCreate heartbeat job during waking hours."
user-invocable: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Heartbeat

Periodic keep-alive and the owner of memory maintenance + wiki orchestration. Evolve is invoked here once per day, but evolve's scope is narrower (skill library only) — heartbeat owns everything else that needs daily upkeep.

## Every Heartbeat

1. Send a brief online status to Telegram (plain text, no emoji).
2. Review the last hour of conversation. For each notable event, write to `journal/YYYY-MM-DD.md` using the format in "Journal Format" below. Tag each entry with:
   - `(skills: x, y)` — which skills the event involved. Feeds evolve's retire signal.
   - `(candidate-skill: <slug>)` — if the work you just did felt like it could be a reusable skill (you wrote a temp script, you ran a multi-step research flow that might recur, you solved something you've solved before). Feeds evolve's upgrade signal. Optional; only annotate when you actually notice the signal in the moment.
3. If a memory-worthy moment happened in the last hour (user stated a new preference, a pattern clarified itself, a feedback that belongs in long-term memory), write a `memory/*.md` entry now with the frontmatter schema from `CLAUDE.md`'s "Memory System" section — `name`, `description`, `type` (user / feedback / project / reference). Don't wait for EOD. Update `memory/MEMORY.md` index with a one-line pointer.
4. **If the bot has a wiki vault configured** (look in `CLAUDE.md` for the vault path), do the wiki loop — silent when nothing qualifies:
   - Scan the last hour for Capture triggers: a finished `learn` session's knowledge output, a multi-turn problem resolution worth reusing, user-dropped raw files in the vault, or an explicit "save this" ask. Run `llm-wiki` **Capture** → **Ingest** for each captured raw. One Capture per focused topic, not per chat.
   - Run `llm-wiki` **Recompile** (§2). Cheap; no-op when nothing is dirty.
   - If anything changed, append one line to today's journal so EOD review sees it.

## Last Heartbeat of the Day

Triggered at the final hour in the waking range. Run in this order — each step reads the output of the previous:

1. **Review today's journal.** Look for notable events, recurring themes, feedback, corrections.
2. **Memory maintenance** (heartbeat's core EOD job):
   - Distill anything in today's journal that deserves long-term memory (patterns, lessons, feedback, project context) into `memory/*.md`. One focused idea per file. Each file uses the frontmatter schema in `CLAUDE.md` (`name` / `description` / `type`). Pick type by content: `feedback` for rules about how to behave, `project` for ongoing work context, `reference` for external pointers, `user` for richer context about the user themself.
   - Prune: remove superseded entries; consolidate duplicates. Budget `min(2 files, 5%)` — conservative. An entry earns removal when a newer file already supersedes it, when it's been promoted into a skill, or when it's >90 days old and no recent journal references it.
   - Keep `memory/MEMORY.md` under 200 lines and pointing only at files that exist. Each line: `- [Title](file.md) — when-relevant hook`.
   - If an existing memory file lacks frontmatter (older bot, pre-schema), add it on the next edit pass — don't do a one-shot migration sweep.
   - Never remove anything the user explicitly said "remember this" about, unless superseded.
3. **Run the `evolve` skill.** Evolve reads cleaned memory + journal and decides skill upgrades/retires on its own budget. See `skills/evolve/SKILL.md`. Heartbeat does not second-guess it.
4. **Wiki EOD pass** (if a vault is configured):
   - If today's memory maintenance or journal review surfaced *world-knowledge* content that accidentally ended up in memory (a fact about some domain, not a user-bot relationship note), that's a case to promote: run `llm-wiki` **Capture** → **Ingest** → **Recompile** for each.
   - Then run `llm-wiki` **Lint** (§4):
     - Mechanical first (`wiki-lint.mjs` — broken links, islands, missing frontmatter).
     - Semantic next (contradictions, stale claims, missing pages, data gaps the bot can spot from the day's reading).
     - Surface findings in the daily summary. Also surface `_wiki/inbox.md` entries that accumulated today — ask whether to Ingest the orphans.
     - Don't auto-fix semantic issues; ask.

## What heartbeat does NOT do

- **Never writes `USER.md`.** The main Agent updates USER.md reactively when the user shares profile info in conversation (per `CLAUDE.md`). Heartbeat doesn't batch-distill into it.
- **Never writes `SOUL.md`.** Only the user directs SOUL changes (the main Agent acts as scribe when they do). Heartbeat and evolve don't touch it.
- **Never touches `IDENTITY.md` or `CLAUDE.md`.** Framework files.

## Monday's Last Heartbeat

Additionally:

1. Read the past week's journals.
2. Identify trends and recurring patterns not obvious in any single day.
3. Consolidate into long-term memory (add/merge entries; no separate mechanism).

## Journal Format

```markdown
# YYYY-MM-DD

## Events
- HH:MM Event description (skills: x, y) (candidate-skill: foo)

## Follow-up
- Items needing attention
```

The `(skills: ...)` and `(candidate-skill: ...)` annotations feed evolve; skip them if neither applies to an entry.
