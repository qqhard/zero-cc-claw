# Cron Tasks

_Your custom recurring tasks. Register them on session start via CronCreate. Edit freely — add/remove entries as your needs change._

This file is for **user-defined** cron work (email summaries, digests, reminders, anything you want your assistant to do on a schedule). The **system** crons — heartbeat and sleep — are wired up automatically from `CLAUDE.md` → "Heartbeat and Sleep", which reads waking hours from `USER.md`.

All cron expressions are in the host's local timezone (see `CLAUDE.md` → Heartbeat for timezone policy).

## Tasks

<!-- Add rows below. Delete this comment once you have at least one task.

| Cron (local) | Purpose | Prompt |
|---|---|---|
| `3 1,10 * * *` | Email summary | Run email summary script, send results to Telegram |
| `3 6 * * *`   | News digest   | Search for recent news, summarize and send to Telegram |

-->
