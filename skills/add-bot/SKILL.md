---
name: add-bot
description: "Create an additional bot/agent under the same parent directory. Triggers: 'add bot', 'new agent', 'create another bot', 'add-bot'."
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
  - TaskCreate
  - TaskUpdate
---

# Add Bot

Create a new bot/agent alongside existing ones. Each bot has its own CLAUDE.md, memory, journal, and Telegram bot.

Plugin root is available as `$CLAUDE_PLUGIN_ROOT`.

## UX Rules

Always present choices as numbered options for the selection bar.

## Steps

**IMPORTANT — Create tasks first:**

- TaskCreate("Create Telegram bot")
- TaskCreate("Name the new agent")
- TaskCreate("Shape agent persona (role, personality, notes)")
- TaskCreate("Generate files")
- TaskCreate("Register with supervisor")
- TaskCreate("Launch and pair")

1. **Detect parent directory**: Look for `ecosystem.config.cjs` in the current directory or parent. If not found, ask the user where their bots live (the directory containing `supervisor/` and `ecosystem.config.cjs`).

2. **Create Telegram bot**: Guide the user to create a new bot via @BotFather for this agent. Parse the token from the pasted BotFather response.

3. **Name the new agent**: Suggest 3-5 mythology/folklore names (different from existing sibling bots — check parent's `ecosystem.config.cjs` to avoid duplicates). Give a one-line reason for each. Let the user pick or type their own.

4. **Shape the persona**: Same three-question flow as the main setup. Use AskUserQuestion with numbered options; always include "Other — type your own":

   a. **Core responsibility** — "What's this agent mainly for?" Since this is an additional bot, bias options toward specialists:
      - Research & knowledge companion
      - Writing & editing partner
      - Coding & engineering sidekick
      - Productivity & task manager
      - General life assistant
      - Other (type your own)

   b. **Personality preference** — "How should they feel to talk to?" Tailor to the chosen name's cultural background when possible:
      - Warm and encouraging
      - Formal and precise
      - Playful and witty
      - Calm and contemplative
      - Blunt and efficient
      - Other (type your own)

   c. **Anything else** — "Anything else you want them to know or embody? (can be skipped)" Short free-form note.

   Draft a 2-4 sentence **Personality** paragraph tying name + tone + notes together. Show it and ask "1. Looks good  2. Let me tweak it". Save the three pieces for file generation.

5. **Generate files** in `<parent>/<agent-name-lowercase>/`:
   - Copy `$CLAUDE_PLUGIN_ROOT/template/CLAUDE.md` → `CLAUDE.md`, fill in agent name, user info (reuse `USER.md` from sibling bot), and the **core responsibility, personality paragraph, notes from user** from step 4.
   - Symlink or copy `USER.md` from the first bot (single source of truth for user profile).
   - Copy `$CLAUDE_PLUGIN_ROOT/start.sh` → `start.sh`, make executable.
   - Create `memory/MEMORY.md`, `journal/`.
   - Initialize git repo.

6. **Register with supervisor**: Add the new bot to the parent's `ecosystem.config.cjs` — add a new entry in the apps array with the new bot's tmux session name. Restart supervisor: `pm2 restart supervisor`.

7. **Launch and pair**:
   - Start the bot: `tmux new-session -d -s <name> -c <bot-dir> './start.sh'`
   - Wait for init, send "start" via send-keys
   - Configure Telegram plugin with the new bot's token via send-keys
   - Guide user to DM the new bot for pairing
   - Confirm success

Show the user how to manage multiple bots:
- `tmux attach -t <name>` to watch any bot
- Supervisor `/status` shows all bots
- Each bot has independent memory and personality
