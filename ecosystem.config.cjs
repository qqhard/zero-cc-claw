module.exports = {
  apps: [
    {
      name: 'supervisor',
      script: 'supervisor/index.mjs',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      env: {
        SUPERVISOR_BOT_TOKEN: '', // your supervisor bot token
        TMUX_SESSION: 'bot',
        WORK_DIR: __dirname,
        ALLOWED_USERS: '', // your Telegram user_id
        WATCHDOG_INTERVAL: '60', // seconds, 0 to disable
      },
    },
  ],
};
