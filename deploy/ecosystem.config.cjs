// pm2 конфиг — запускать из корня репо: pm2 startOrReload deploy/ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'veplay',
      script: 'server.mjs',
      cwd: '/opt/veplay/app',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        PORT: 3001,
        HOST: '127.0.0.1',          // наружу смотрит только Caddy
        MUSIC_ROOT: '/var/vegroove/music',
        DATA_DIR: '/var/vegroove',  // users.json и .secret — вне репозитория
        // ADMIN_USER / ADMIN_PASS учитываются только при САМОМ ПЕРВОМ запуске
        // (сидинг администратора). Задайте до первого старта или смените пароль в UI.
      },
    },
  ],
}
