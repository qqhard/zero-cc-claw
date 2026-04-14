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
        WATCHDOG_INTERVAL: '60',  // seconds, 0 to disable
        // Bot definitions: name:tmux_session:work_dir (comma-separated for multiple bots)
        // Example single bot:  "thoth:thoth:/home/user/workspace/thoth"
        // Example multi bot:   "thoth:thoth:/home/user/workspace/thoth,hermes:hermes:/home/user/workspace/hermes"
        BOTS: '',
      },
    },
  ],
};
