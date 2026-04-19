# Heartbeat Tasks

_Your hourly checklist. Keep it short; it runs every hour. Add or remove items freely — except items tagged **[system]**, which have a contract with the supervisor or Claude Code's mechanisms (journal format, MCP marker). You can still remove those, just understand what breaks first._

See `CLAUDE.md` → "Heartbeat and Sleep" for scope, invariants, and cron wiring.

## Every heartbeat

- **[system]** Send a brief online status to Telegram (plain text, no emoji). If the Telegram reply tool is unavailable (MCP disconnected), skip the ping and note it in the journal. The restart marker goes at the end, not here.
- Review the last hour of conversation for notable events.
- **[system]** Write events to `journal/YYYY-MM-DD.md` using the journal format in `CLAUDE.md`. Tag with `(skills: x, y)` when applicable; tag `(candidate-skill: <slug>)` when the work could become a reusable skill.
- Write to `memory/*.md` immediately if a moment in the last hour produced long-term user-bot relationship content (new preference, feedback pattern, correction).
- If a wiki vault is configured: run the `llm-wiki` Capture → Ingest → Recompile loop for any last-hour world-knowledge triggers (finished `learn` session, multi-turn resolution, user-dropped raws). Silent when nothing qualifies.
- **[system] Last step**: if step 1 was skipped for MCP disconnect, run `mkdir -p .zero-claw && touch .zero-claw/mcp-disconnected`. Supervisor will see it and restart the bot to reconnect. Must be last — otherwise the restart eats unsaved journal/memory/wiki writes above.

## Proactive checks (rotate — not every heartbeat, every few)

- (add items here — e.g. "check inbox for urgent unread", "check calendar for events in next 24h", "git status on active projects")

## Do NOT disturb

- Outside waking hours — the cron shouldn't fire then, but if it does, stay silent.
- When the user is clearly busy / mid-conversation with another person.
- Triple-tap: don't send multiple heartbeats in a row for the same state.

## Notes to future-you

(anything you've learned about your own heartbeat behavior — patterns to avoid, things that worked)
