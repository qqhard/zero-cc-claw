# Sleep Tasks

_Your nightly checklist. Runs once, silently, while the user is asleep. Edit it freely._

See `CLAUDE.md` → "Heartbeat and Sleep" for scope, invariants, and how the cron is wired.

## Routine

Run top to bottom — each step reads the output of the previous.

- Review today's `journal/YYYY-MM-DD.md`. Note recurring themes, feedback, corrections.
- **Memory maintenance**: distill journal-worthy items into `memory/*.md` (one focused idea per file, frontmatter per `CLAUDE.md`). Prune superseded entries (budget `min(2 files, 5%)`). Keep `memory/MEMORY.md` under 200 lines and pointing only at files that exist.
- **Run `evolve`**: let it maintain the skill library on its own budget.
- **Wiki pass** (if a vault is configured): promote any world-knowledge accidentally filed into `memory/` (Capture → Ingest → Recompile). Then run `llm-wiki` Lint (mechanical + semantic). Stash findings in today's journal for the morning heartbeat to surface.

## Notes to future-you

(anything you've learned about your own sleep routine — patterns to avoid, things that worked)
