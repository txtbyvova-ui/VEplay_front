# Деплой VEgroove Play на голый Ubuntu VPS

Целевая среда: Ubuntu 22.04/24.04, домен **play.vegroove.tech**, IP **92.246.138.135**.
Стек: Node 24 + pm2 (бэкенд `server.mjs`) + Caddy (статика фронта, reverse-proxy, авто-HTTPS).

## 0. DNS — сделать ДО всего остального

Сейчас `play.vegroove.tech` — CNAME на Vercel. Пока это так, Caddy **не получит
сертификат** Let's Encrypt. В DNS-панели домена:

1. Удалить CNAME для `play`.
2. Создать `A`-запись: `play` → `92.246.138.135`.
3. (Опционально) `AAAA`-запись на адрес из вашей IPv6-подсети `2a12:5940:dbcd::/48` —
   только если этот адрес реально поднят на интерфейсе VPS (`ip -6 addr`).

Проверка: `dig +short play.vegroove.tech` → `92.246.138.135`.

## 1. Базовая система (от root)

```bash
apt update && apt -y upgrade
apt -y install git curl ufw

# файрвол: SSH + HTTP/HTTPS
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

## 2. Node 24 LTS + pm2

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt -y install nodejs
node -v            # v24.x

npm install -g pm2
```

## 3. Caddy

```bash
apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy
```

## 4. Пользователь и каталоги

```bash
# отдельный пользователь для приложения
useradd -m -s /bin/bash veplay

# код
mkdir -p /opt/veplay
chown veplay:veplay /opt/veplay

# данные (вне репозитория, переживают любой redeploy):
#   /var/vegroove/users.json  /var/vegroove/.secret  /var/vegroove/music/<клиент>/...
mkdir -p /var/vegroove/music
chown -R veplay:veplay /var/vegroove
chmod 750 /var/vegroove
```

## 5. Клон и сборка

```bash
su - veplay
git clone https://github.com/txtbyvova-ui/VEplay_front.git /opt/veplay/app
cd /opt/veplay/app

# фронту нужен адрес API на этапе сборки
cp .env.example .env
sed -i 's|^VITE_API_BASE=.*|VITE_API_BASE=https://play.vegroove.tech|' .env

npm ci
npm run build       # tsc -b && vite build → dist/
```

## 6. Первый запуск бэкенда

Пароль первого администратора: задайте свой ДО первого старта (иначе будет
`admin`/`admin` — сервер напишет об этом в лог, а UI будет требовать смену).

```bash
# всё ещё под veplay, в /opt/veplay/app
ADMIN_USER=admin ADMIN_PASS='ВАШ_НАДЁЖНЫЙ_ПАРОЛЬ' node server.mjs
# убедиться, что в логе "Seeded default admin", затем Ctrl+C
```

`ADMIN_USER`/`ADMIN_PASS` действуют только при самом первом запуске — потом
пользователи живут в `/var/vegroove/users.json`.

Запуск под pm2 + автостарт после ребута:

```bash
pm2 startOrReload deploy/ecosystem.config.cjs
pm2 save
exit                              # обратно в root
env PATH=$PATH pm2 startup systemd -u veplay --hp /home/veplay
# выполнить команду, которую выведет pm2 startup (она уже с sudo)
```

## 7. Caddy: статика + proxy + HTTPS

```bash
cp /opt/veplay/app/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy сам получит сертификат Let's Encrypt (нужен уже переключённый DNS, шаг 0)
и сам редиректит http→https.

## 8. Проверка

```bash
curl -I  https://play.vegroove.tech                     # 200, статика
curl -sI http://play.vegroove.tech | head -1            # 308 → https
curl -s  https://play.vegroove.tech/auth/me             # {"error":"Unauthorized"} — API жив
pm2 status                                              # veplay online
reboot                                                  # после ребута pm2 должен поднять veplay сам
```

Дальше — зайти на https://play.vegroove.tech под админом, создать первого
клиента (папка + логин + одноразовый пароль создаются автоматически) и
загрузить mp3 по категориям.

## 9. Обновление (после git push)

```bash
sudo -u veplay bash /opt/veplay/app/deploy/deploy.sh
```

(git pull → npm ci → build → pm2 reload — без даунтайма.)

## Заметки

- Бэкенд слушает только `127.0.0.1:3001` (`HOST` в ecosystem-конфиге) — снаружи
  доступен только через Caddy.
- Rate-limit на `/auth/login`: 10 попыток / 15 минут с одного IP; реальный IP
  берётся из `X-Forwarded-For` только для соединений с localhost (т.е. от Caddy).
- Лимиты загрузки: только mp3 (`audio/mpeg`), ≤ 20MB на файл, ≤ 20 файлов за раз.
- Бэкап = скопировать `/var/vegroove` целиком (users.json, .secret, музыка).
