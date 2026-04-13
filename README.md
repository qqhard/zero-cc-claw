# Zero-Claw

> v0.1.0

Turn [Claude Code](https://claude.ai/claude-code) into a personal AI assistant you can talk to on Telegram. No server, no database, no gateway — just compose existing tools.

## Why

Building a personal AI assistant usually means writing a server, managing a database, wiring up APIs, and deploying infrastructure. Zero-Claw skips all of that.

Claude Code already has tool use, code execution, file I/O, and MCP integrations. Telegram already has a bot API. tmux already manages persistent sessions. pm2 already does process supervision.

**Zero-Claw just glues them together** with a ~180-line supervisor script and a `CLAUDE.md` file that defines your bot's behavior in plain language.

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
- **Memory** — journals daily events, distills long-term knowledge, tracks your preferences
- **Heartbeat** — hourly check-in during waking hours, no disturbance at night
- **Supervisor** — remote restart, status check, log viewer, terminal input via Telegram
- **Watchdog** — auto-restarts if the bot crashes
- **Extensible** — add skills as folders, add MCP servers, customize `CLAUDE.md`

## Quick Start

### Prerequisites

- [Claude Code](https://claude.ai/claude-code) subscription
- [tmux](https://github.com/tmux/tmux), [Node.js](https://nodejs.org/) >= 18, [pm2](https://pm2.keymetrics.io/)

### Install

```bash
# 1. Add the Zero-Claw marketplace
claude plugin marketplace add qqhard/zero-claw

# 2. Install the plugin
claude plugin install zero-claw

# 3. Run the setup wizard (inside Claude Code)
/zero-claw:setup
```

The wizard will walk you through:

1. Choose your language
2. Check prerequisites
3. Create two Telegram bots (main + supervisor)
4. Set your name, timezone, and name your assistant
5. Generate all config files
6. Launch the bot and pair Telegram

Everything is interactive — just follow the prompts.

### After Setup

```bash
# Launch (attaches to tmux so you can watch)
tmux new-session -s <assistant-name> -c ~/<assistant-name> './start.sh'

# Detach: Ctrl-b d
# Re-attach: tmux attach -t <assistant-name>
```

### Supervisor Commands

Send these to your supervisor bot on Telegram:

| Command | Action |
|---------|--------|
| `/restart` | Restart the assistant |
| `/status` | Check if running |
| `/logs` | Last 80 lines of output |
| `/screen` | Current terminal screen |
| `/send <text>` | Type into the assistant's terminal |
| `/help` | Show all commands |

## Philosophy

1. **No wheels** — Don't build what exists. Claude Code is the brain, Telegram is the mouth, tmux is the body.
2. **CLAUDE.md is the app** — Behavior defined in natural language, not code. Change the personality, add cron jobs, set rules — all in one file.
3. **Skills are folders** — A `SKILL.md` file in a folder = a plugin. No package manager needed.
4. **Memory follows git** — `journal/`, `memory/`, `USER.md` are git-tracked. Clone = restore.
5. **Minimal code** — If Claude Code can do it via instructions, don't write code for it.

## Project Structure

```
zero-claw/
├── skills/
│   ├── setup/SKILL.md        # Interactive setup wizard
│   └── heartbeat/SKILL.md    # Heartbeat + journaling
├── supervisor/
│   └── index.mjs             # Supervisor bot (~180 lines)
├── template/
│   ├── CLAUDE.md              # Bot personality template
│   └── USER.md                # User profile template
├── commands/
│   └── setup.md               # /zero-claw:setup entry point
├── .claude-plugin/
│   ├── plugin.json            # Plugin metadata
│   └── marketplace.json       # Marketplace definition
├── start.sh                   # One-line launcher
├── ecosystem.config.cjs       # pm2 config template
├── DESIGN.md                  # Architecture deep-dive (Chinese)
└── INSTALL.md                 # Reference guide
```

## Extending Your Bot

**Add a skill**: Create a folder in `.claude/skills/` with a `SKILL.md`.

**Add MCP tools**: Configure in `.claude/settings.json` — Gmail, Calendar, Notion, etc.

**Add cron jobs**: Edit `CLAUDE.md`, add rows to the Cron Tasks table.

**Change personality**: Edit `CLAUDE.md` — role, principles, communication style.

## License

MIT
