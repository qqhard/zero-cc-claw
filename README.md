# Zero-Claw

Turn [Claude Code](https://claude.ai/claude-code) into a personal AI assistant on Telegram.

## Quick Start

Prerequisite: a [Claude Code](https://claude.ai/claude-code) subscription. Setup checks for `tmux`, `node`, `pm2`, `bun` and walks you through any missing installs.

In a Claude Code session:

```
/plugin marketplace add qqhard/zero-claw
/plugin install zero-claw
/zero-claw:setup
```

The setup wizard handles everything interactively — prerequisites, Telegram bots, config, launch, and pairing.

**Coming from OpenClaw?** Run `/zero-claw:migrate-from-openclaw` instead of `setup` — one command ports over your agents, personas, memory, skills, scripts, and MCPs, and only asks BotFather for a supervisor bot if you don't already have one.

## What Is This

Claude Code is already a mature, secure, and intelligent coding agent — tool use, code execution, file I/O, MCP integrations, all built in and continuously improving. The [Telegram channel plugin](https://github.com/anthropics/claude-plugins-official) lets it receive and reply to messages.

**That's already 90% of a personal AI assistant.** You don't need a custom server, a message router, or an agent framework. You just need Claude Code + a channel.

Zero-Claw adds the remaining 10%:

- **Supervisor** — a small Telegram bot for remote restart, status checks, and crash recovery. Because the main bot runs in tmux, you need a way to control it when it's stuck.
- **Persistent memory** — a heartbeat-driven journal that records daily events and distills long-term knowledge. Claude Code's built-in memory is selective; the journal catches everything.
- **Heartbeat & Sleep** — two independent crons. Heartbeat fires hourly during waking hours: online status, conversation review, journal writes. Sleep fires once per day at the end of waking hours: memory distillation, prune, `evolve`, wiki lint.
- **CLAUDE.md template** — defines your assistant's personality, rules, and cron jobs in plain language. This *is* the app — Claude Code executes it.

Your bot's capabilities grow automatically as Claude Code evolves. New tools, better reasoning, new MCP integrations — you get them for free without changing a line of code. Zero-Claw's skill system is just Claude Code's native skill format, fully compatible and reusable.

### Comparison

| | Traditional bot | Zero-Claw |
|---|---|---|
| Backend | Custom server | Claude Code |
| Communication | Custom gateway | Telegram plugin |
| Deployment | Docker + DB + config | tmux + pm2 |
| Custom code | Thousands of lines | Just a small supervisor |
| AI upgrades | Manual integration | Automatic (Claude Code updates) |
| Skills/plugins | Custom plugin system | Claude Code native skills |

## How It Works

```
You (Telegram)
     |
     v
Main Bot ---- Claude Code + Telegram plugin
     |              |
     |         tmux session (persistent)
     |              |
     |         CLAUDE.md --- personality, cron, memory rules
     |              |
     |         journal/ ---- daily logs (heartbeat-driven)
     |         memory/ ----- long-term knowledge
     |         USER.md ----- your profile
     |
Supervisor Bot ---- Node.js + pm2
                    |
               tmux send-keys (restart, status, logs)
               watchdog (auto-restart on crash)
```

**Two Telegram bots, one brain:**
- **Main bot** — your assistant. Chat, ask questions, run tasks.
- **Supervisor bot** — remote control. `/restart`, `/status`, `/logs` when the main bot is stuck.

## Features

- **Conversational setup** — run `/zero-claw:setup`, answer a few questions, done
- **Memory** — journals daily events, distills long-term knowledge, tracks your preferences in `USER.md`
- **Heartbeat** — hourly check-in during waking hours, no disturbance at night
- **Supervisor** — remote restart, status check, log viewer, terminal input via Telegram
- **Watchdog** — auto-restarts if the bot crashes
- **Extensible** — add skills as folders, add MCP servers, customize `CLAUDE.md`

## Supervisor Commands

Send these to your supervisor bot on Telegram:

| Command | Action |
|---------|--------|
| `/restart` | Restart the assistant |
| `/stop` | Stop the assistant |
| `/start` | Start the assistant |
| `/status` | Status (all bots if multiple configured) |
| `/logs` | Last 80 lines of output |
| `/screen` | Current terminal screen |
| `/send <text>` | Type into the assistant's terminal |
| `/monitor [on\|off\|status]` | Push new pane output to Telegram on an interval |
| `/help` | Show all commands |

When multiple bots are configured, pass the bot name after the command (e.g. `/restart main`).

## Commands

Run these in a Claude Code session once the plugin is installed.

| Command | What it does |
|---|---|
| `/zero-claw:setup` | First-run wizard — prereqs, two bots, config, launch, pair |
| `/zero-claw:add-bot` | Add another agent under an existing parent directory |
| `/zero-claw:upgrade` | Upgrade an existing bot to the latest template without overwriting your persona |
| `/zero-claw:upgrade-meta-skill` | Refresh meta-skills (evolve, llm-wiki, learn) across every bot in the project |
| `/zero-claw:migrate-from-openclaw` | Import an existing OpenClaw workspace — preserves agents, personas, memory, skills, scripts, MCPs; only asks BotFather for a supervisor if none exists |
| `/zero-claw:evolve` | Run the evolve meta-skill manually (normally auto-triggered by the nightly sleep job) |
| `/zero-claw:llm-wiki` | Ingest notes, recompile pages, search, or lint your knowledge vault (Karpathy-style LLM wiki) |
| `/zero-claw:learn` | Socratic learning mode — 3 consensuses / 3 controversies, layered deep-dive, 20/80, then 5 retrieval questions |

The upgrade wizard detects your current setup, shows what's changed, and lets you choose what to update. It never overwrites your `CLAUDE.md` / `SOUL.md` / `IDENTITY.md` persona or custom config — only adds missing sections and replaces infrastructure components (supervisor, `start.sh`, built-in skills).

## Extending Your Bot

**Add a skill** — Create a folder in `.claude/skills/` with a `SKILL.md`. Same format as any Claude Code skill.

**Add MCP tools** — Gmail, Calendar, Notion, etc. Configure in `.claude/settings.json`.

**Add cron jobs** — Edit `CLAUDE.md`, add rows to the Cron Tasks table.

**Change personality** — Edit `CLAUDE.md` — role, principles, communication style.

## Project Structure

```
zero-claw/                            (Claude Code plugin)
├── skills/
│   ├── setup/                        # /zero-claw:setup
│   ├── add-bot/                      # /zero-claw:add-bot
│   ├── upgrade/                      # /zero-claw:upgrade
│   ├── upgrade-meta-skill/           # /zero-claw:upgrade-meta-skill
│   ├── migrate-from-openclaw/        # /zero-claw:migrate-from-openclaw
│   ├── evolve/                       # Self-compression meta-skill (copied into each bot)
│   ├── llm-wiki/                     # Karpathy-style LLM wiki compiler meta-skill (copied into each bot)
│   ├── learn/                        # Socratic learning meta-skill (copied into each bot)
│   └── heartbeat/                    # Hourly cron (autonomous)
├── supervisor/
│   └── index.mjs                     # Supervisor bot
├── template/
│   ├── CLAUDE.md                     # Session rules, heartbeat policy, memory
│   ├── IDENTITY.md                   # Name, creature, vibe, emoji, avatar
│   ├── SOUL.md                       # Core truths, boundaries, personality
│   ├── HEARTBEAT.md                  # Self-editable heartbeat checklist
│   └── USER.md                       # User profile
├── commands/                         # Slash-command shortcuts
└── start.sh                          # One-line launcher
```

## Design Principles

1. **Don't build what exists** — Claude Code is the brain, Telegram is the mouth, tmux is the body. The only custom code is the supervisor.
2. **CLAUDE.md is the app** — Behavior defined in natural language. Personality, cron, rules — all in one file that Claude Code executes directly.
3. **Evolve with the platform** — No abstraction layers. When Claude Code gets better, your bot gets better. Skills are native Claude Code skills.
4. **Memory follows git** — `journal/`, `memory/`, `USER.md` are git-tracked. Clone the repo on a new machine, your assistant remembers everything.
5. **Minimal code, maximum leverage** — If Claude Code can do it via CLAUDE.md instructions, don't write code for it.

## License

MIT
