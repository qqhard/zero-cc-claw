# Zero-Claw

> v0.2.0

Turn [Claude Code](https://claude.ai/claude-code) into a personal AI assistant on Telegram.

## Quick Start

Prerequisites: [Claude Code](https://claude.ai/claude-code) subscription + [bun](https://bun.sh/)

In a Claude Code session:

```
/plugin marketplace add qqhard/zero-claw
/plugin install zero-claw
/zero-claw:setup
```

The setup wizard handles everything interactively — prerequisites, Telegram bots, config, launch, and pairing.

## What Is This

Claude Code is already a mature, secure, and intelligent coding agent — tool use, code execution, file I/O, MCP integrations, all built in and continuously improving. The [Telegram channel plugin](https://github.com/anthropics/claude-plugins-official) lets it receive and reply to messages.

**That's already 90% of a personal AI assistant.** You don't need a custom server, a message router, or an agent framework. You just need Claude Code + a channel.

Zero-Claw adds the remaining 10%:

- **Supervisor** (~180 lines) — a Telegram bot for remote restart, status checks, and crash recovery. Because the main bot runs in tmux, you need a way to control it when it's stuck.
- **Persistent memory** — a heartbeat-driven journal that records daily events and distills long-term knowledge. Claude Code's built-in memory is selective; the journal catches everything.
- **Heartbeat** — hourly cron during waking hours. Sends online status, reviews conversations, maintains the journal. Last heartbeat of the day consolidates memory.
- **CLAUDE.md template** — defines your assistant's personality, rules, and cron jobs in plain language. This *is* the app — Claude Code executes it.

Your bot's capabilities grow automatically as Claude Code evolves. New tools, better reasoning, new MCP integrations — you get them for free without changing a line of code. Zero-Claw's skill system is just Claude Code's native skill format, fully compatible and reusable.

### Comparison

| | Traditional bot | Zero-Claw |
|---|---|---|
| Backend | Custom server | Claude Code |
| Communication | Custom gateway | Telegram plugin |
| Deployment | Docker + DB + config | tmux + pm2 |
| Custom code | Thousands of lines | ~180 lines (supervisor only) |
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
| `/status` | Check if running |
| `/logs` | Last 80 lines of output |
| `/screen` | Current terminal screen |
| `/send <text>` | Type into the assistant's terminal |
| `/help` | Show all commands |

## Upgrading

Already have a bot running? Upgrade to the latest Zero-Claw in a Claude Code session:

```
/zero-claw:upgrade
```

The upgrade wizard detects your current setup, shows what's changed, and lets you choose what to update. It never overwrites your CLAUDE.md personality or custom config — only adds missing sections and replaces infrastructure components (supervisor, start.sh, skills).

## Extending Your Bot

**Add a skill** — Create a folder in `.claude/skills/` with a `SKILL.md`. Same format as any Claude Code skill.

**Add MCP tools** — Gmail, Calendar, Notion, etc. Configure in `.claude/settings.json`.

**Add cron jobs** — Edit `CLAUDE.md`, add rows to the Cron Tasks table.

**Change personality** — Edit `CLAUDE.md` — role, principles, communication style.

## Project Structure

```
zero-claw/                        (Claude Code plugin)
├── skills/
│   ├── setup/SKILL.md            # Interactive setup wizard
│   └── heartbeat/SKILL.md        # Heartbeat + journaling
├── supervisor/
│   └── index.mjs                 # Supervisor bot (~180 lines)
├── template/
│   ├── CLAUDE.md                 # Bot personality template
│   └── USER.md                   # User profile template
├── commands/
│   └── setup.md                  # /zero-claw:setup entry point
└── start.sh                      # One-line launcher
```

## Design Principles

1. **Don't build what exists** — Claude Code is the brain, Telegram is the mouth, tmux is the body. The only custom code is the supervisor.
2. **CLAUDE.md is the app** — Behavior defined in natural language. Personality, cron, rules — all in one file that Claude Code executes directly.
3. **Evolve with the platform** — No abstraction layers. When Claude Code gets better, your bot gets better. Skills are native Claude Code skills.
4. **Memory follows git** — `journal/`, `memory/`, `USER.md` are git-tracked. Clone the repo on a new machine, your assistant remembers everything.
5. **Minimal code, maximum leverage** — If Claude Code can do it via CLAUDE.md instructions, don't write code for it.

## License

MIT
