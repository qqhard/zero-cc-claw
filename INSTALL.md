# Zero-Claw Setup Guide

Turn Claude Code into a personal AI assistant with Telegram. Zero infrastructure — just compose existing tools.

## What You Get

- A persistent AI assistant reachable via Telegram
- A supervisor bot for remote session control (restart, status, logs)
- Memory system that persists across sessions
- Heartbeat mechanism for keep-alive and journaling
- Optional plugins for email, calendar, knowledge base, etc.

## Prerequisites

- [Claude Code](https://claude.ai/claude-code) (subscription)
- [tmux](https://github.com/tmux/tmux)
- [Node.js](https://nodejs.org/) >= 18
- [pm2](https://pm2.keymetrics.io/) (`npm install -g pm2`)

## Step 1: Clone and Install

```bash
git clone https://github.com/anthropics/zero-claw.git
cd zero-claw
cd supervisor && npm install && cd ..
```

## Step 2: Create Two Telegram Bots

Open [@BotFather](https://t.me/BotFather) on Telegram and create **two** bots:

1. **Main bot** — your assistant's face (e.g. `@my_assistant_bot`)
2. **Supervisor bot** — remote control (e.g. `@my_supervisor_bot`)

Save both tokens.

## Step 3: Configure Claude Code Telegram Plugin

```bash
claude plugins install telegram
```

Launch Claude Code once to configure the Telegram channel:

```bash
claude --channels plugin:telegram
```

Follow the prompts to paste your **main bot** token and pair your account.

## Step 4: Configure Supervisor

Edit `ecosystem.config.cjs`:

```javascript
SUPERVISOR_BOT_TOKEN: 'your-supervisor-bot-token-here',
TMUX_SESSION: 'bot',          // tmux session name
ALLOWED_USERS: '123456789',   // your Telegram user_id
```

> **Find your user_id**: message [@userinfobot](https://t.me/userinfobot) on Telegram.

## Step 5: Customize Your Bot

Copy the template and edit it:

```bash
cp template/CLAUDE.md CLAUDE.md
```

Fill in your info and set your preferred language:

```markdown
## User Info
- Name: Your Name
- Timezone: Your/Timezone
- Telegram chat_id: your_chat_id
- Language: English  # or Chinese, Japanese, etc.
```

The bot will match your language in all replies.

## Step 6: Launch

```bash
# Start supervisor first
pm2 start ecosystem.config.cjs
pm2 save

# Launch Claude Code in tmux (you'll see it start up)
tmux new-session -s mybot -c /path/to/zero-claw './start.sh'
# Detach later with Ctrl-b d, re-attach with: tmux attach -t mybot
```

## Step 7: Verify

1. Send a message to your **main bot** on Telegram — it should reply
2. Send `/status` to your **supervisor bot** — it should report "Running"
3. Send `/restart` to your **supervisor bot** — it should restart the session

## Supervisor Commands

| Command | Action |
|---------|--------|
| `/restart` | Kill and restart Claude Code |
| `/stop` | Stop Claude Code |
| `/start` | Start Claude Code |
| `/status` | Check if running + PID |
| `/logs` | Last 80 lines of terminal |
| `/screen` | Current terminal screen |
| `/send <text>` | Type into Claude Code TUI |

## Optional Plugins

Plugins are Claude Code skills. To install one, copy its folder into `.claude/skills/`:

```bash
cp -r plugins/<plugin-name> .claude/skills/
```

See `plugins/README.md` for available options.

## Architecture

```
You (Telegram)
    |
    v
Main Bot (Claude Code + Telegram plugin)
    |
    +-- tmux session "bot"
    |       runs: claude --channels plugin:telegram
    |
    +-- CLAUDE.md (personality, cron, memory config)
    |
    +-- memory/ (persistent across sessions)

Supervisor Bot (Node.js + pm2)
    |
    +-- tmux send-keys (controls main bot)
    +-- watchdog (auto-restart on crash)
```

No custom server. No database. No API gateway. Just tmux + Claude Code + Telegram.
