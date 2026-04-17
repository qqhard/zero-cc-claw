module.exports = {
  apps: [
    {
      name: 'supervisor',  // IMPORTANT: rename to <dirname>-supervisor to avoid pm2 collisions
      script: 'supervisor/index.mjs',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      env: {
        SUPERVISOR_BOT_TOKEN: '', // your supervisor bot token
        ALLOWED_USERS: '',        // your Telegram user_id
        WATCHDOG_INTERVAL: '60',          // seconds between liveness checks, 0 to disable
        MAX_CONSECUTIVE_RESTARTS: '5',    // give up and notify user after this many failed restarts
        CONTEXT_CHECK_INTERVAL: '86400',  // seconds between context-usage checks (24h), 0 to disable
        CONTEXT_THRESHOLD: '50',          // restart when Claude context usage exceeds this %
        CONTEXT_CACHE_SECONDS: '300',     // reuse last /context query within this many seconds (avoids spamming the bot's TUI)
        MONITOR_INTERVAL: '0',    // seconds between pane-diff pushes (0 = disabled, 30 recommended)
        // Bot definitions: name:tmux_session:work_dir (comma-separated for multiple bots)
        // Example single bot:  "thoth:thoth:/home/user/workspace/thoth"
        // Example multi bot:   "thoth:thoth:/home/user/workspace/thoth,hermes:hermes:/home/user/workspace/hermes"
        BOTS: '',
      },
    },
  ],
};
