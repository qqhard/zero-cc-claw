---
name: heartbeat
description: "Periodic keep-alive and journaling. Called by CronCreate heartbeat job during waking hours."
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

Periodic keep-alive, journaling, and memory consolidation.

## Every Heartbeat

1. Send a brief online status to Telegram (plain text, no emoji)
2. Review recent conversation for notable events
3. Write events to `journal/YYYY-MM-DD.md`. Tag each entry with skills that triggered — format: `- HH:MM event text (skills: x, y)`. This feeds evolve's usage signal.
4. **If the bot has a wiki vault configured** (look in `CLAUDE.md` for the vault path), do the wiki loop — silent when there's nothing to do:
   - Review the last hour of chat + journal updates. Triggers at this cadence are the ones that happened within the last hour: a finished `learn` session, a multi-turn problem resolution worth reusing, or user-dropped raw files in the vault. Run **Capture** → **Ingest** for each captured raw. One Capture per focused topic, not one per chat.
   - Run `llm-wiki` **Recompile** (§2). Cheap; no-op when nothing is dirty.
   - If anything changed (captured, ingested, recompiled, or orphan sources newly in inbox), append a one-line note to today's journal so EOD review sees it.

## Last Heartbeat of the Day

Triggered at the final hour in the waking range:

1. Review today's journal
2. Distill important information:
   - User preferences or feedback → update `USER.md`
   - Patterns, lessons, outcomes → write to `memory/` files
3. Update `memory/MEMORY.md` index
4. Prune outdated or superseded memory files
5. Keep `memory/MEMORY.md` under 200 lines
6. Run the `evolve` skill — it will autonomously upgrade (add/edit) and forget across skills, SOUL, and memory per its own budgets. This is where `evolve` lives — once per day, after distillation, not on every heartbeat.
7. **If a wiki vault is configured**, do the EOD wiki pass:
   - Today's distillation + evolve may have surfaced `memory/` or `SOUL.md` content that has outgrown private-memory format and deserves vault-level promotion (durable, queryable, cross-linked). If so, run `llm-wiki` **Capture** → **Ingest** for each, then **Recompile**.
   - Then run `llm-wiki` **Lint** (§4):
   - Mechanical first (`wiki-lint.mjs` — broken links, islands, missing frontmatter).
   - Semantic next (contradictions, stale claims, missing pages, data gaps the bot can spot from the day's reading).
   - Surface all findings in the daily summary. Also surface `_wiki/inbox.md` entries that accumulated today (orphan raw sources the user dropped in — ask whether to Ingest).
   - Don't auto-fix semantic issues; ask.

## Monday's Last Heartbeat

Additionally:
1. Read the past week's journals
2. Identify trends and recurring patterns
3. Consolidate into long-term memory

## Journal Format

```markdown
# YYYY-MM-DD

## Events
- HH:MM Event description

## Follow-up
- Items needing attention
```
