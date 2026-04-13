---
name: heartbeat
description: "Periodic keep-alive and journaling. Called by CronCreate heartbeat job."
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

Periodic keep-alive and journaling skill.

## Behavior

1. Send a brief online status to Telegram (plain text, no emoji)
2. Review recent conversation for notable events
3. Write events to `memory/journal/YYYY-MM-DD.md`

### Last heartbeat of the day
- Distill journal entries into long-term memory files under `memory/`

### Monday's last heartbeat
- Additionally do a weekly review across the week's journals

## Journal Format

```markdown
# YYYY-MM-DD

## Events
- HH:MM Event description

## Follow-up
- Items needing attention
```
