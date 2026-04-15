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

## Last Heartbeat of the Day

Triggered at the final hour in the waking range:

1. Review today's journal
2. Distill important information:
   - User preferences or feedback → update `USER.md`
   - Patterns, lessons, outcomes → write to `memory/` files
3. Update `memory/MEMORY.md` index
4. Prune outdated or superseded memory files
5. Keep `memory/MEMORY.md` under 200 lines
6. Run the `evolve` skill — it will autonomously add/grind/forget across skills, SOUL, and memory per its own budgets.

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
