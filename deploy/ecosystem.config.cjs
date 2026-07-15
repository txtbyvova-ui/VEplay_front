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
        DATA_DIR: '/var/vegroove',  // users.json, .secret, pending_batches.json — вне репозитория
        // ADMIN_USER / ADMIN_PASS учитываются только при САМОМ ПЕРВОМ запуске
        // (сидинг администратора). Задайте до первого старта или смените пароль в UI.

        // ── VEclassify (аудио → morning/day/evening). Классификатор лежит рядом с
        // app: /opt/veplay/VEclassify (сервер и сам ищет ../VEclassify/.venv, но
        // задаём явно). GEMINI_API_KEY с рабочей квотой — в /opt/veplay/VEclassify/.env
        CLASSIFY_PYTHON: '/opt/veplay/VEclassify/.venv/bin/python',
        CLASSIFY_SCRIPT: '/opt/veplay/VEclassify/classify_stage.py',
        // Большие загрузки (папка на классификацию до 2 ГБ) — не резать по таймауту.
        // Дефолт 1 час; 0 = без ограничения. Node-дефолт (300с) давал 408 на VPS.
        REQUEST_TIMEOUT_MS: 3600000,
      },
    },
  ],
}
