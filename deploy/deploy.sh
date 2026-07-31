#!/usr/bin/env bash
# Обновление прода: git pull → npm ci → build → pm2 reload.
# На боевом сервере приложение работает под root (пользователя veplay нет),
# поэтому запускать от root из любого места:
#   bash /opt/veplay/app/deploy/deploy.sh
# Подробности схемы — в README_DEPLOY.md.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> git pull"
git pull --ff-only

echo "==> npm ci"
npm ci

echo "==> build (tsc -b && vite build)"
npm run build

echo "==> pm2 reload"
pm2 startOrReload deploy/ecosystem.config.cjs
pm2 save

echo "==> done"
