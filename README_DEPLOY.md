# Деплой VEgroove Play на VPS

Боевой сервер: **play.vegroove.tech**, IP **92.246.138.135**, Ubuntu 26.04 LTS.
Стек: Node 24 + pm2 (бэкенд `server.mjs`) + Caddy (статика фронта, reverse-proxy,
авто-HTTPS). Docker не используется.

> Документ описывает то, как сервер устроен **на самом деле**. Раньше здесь была
> схема с отдельным пользователем `veplay` — на боевой машине её нет, всё работает
> под `root`. См. «Почему под root» в конце.

---

## Как это работает сейчас

| Что | Где |
|-----|-----|
| Код | `/opt/veplay/app` — git-клон, ветка `main`, remote `origin` |
| Процесс | pm2 (`/root/.pm2`), приложение зарегистрировано как **`veplay`** |
| Бэкенд | `node /opt/veplay/app/server.mjs`, слушает `127.0.0.1:3001` |
| Статика | `/opt/veplay/app/dist`, раздаёт Caddy |
| Данные | `/var/vegroove` — `users.json`, `.secret`, `music/<клиент>/…` |
| Конфиг Caddy | `/etc/caddy/Caddyfile` (копия `deploy/Caddyfile`) |
| Автозапуск | systemd-юнит `pm2-root` (`systemctl is-enabled pm2-root` → `enabled`) |

Переменные окружения процесса задаёт `deploy/ecosystem.config.cjs`
(`PORT`, `HOST`, `MUSIC_ROOT`, `DATA_DIR`, `CLASSIFY_*`, `REQUEST_TIMEOUT_MS`).

Всё выполняется **от root**, никакого `sudo -u veplay` — такого пользователя нет.

---

## Обновление прода (основной сценарий)

```bash
ssh root@92.246.138.135
bash /opt/veplay/app/deploy/deploy.sh
```

Скрипт делает `git pull --ff-only` → `npm ci` → `npm run build` → `pm2 startOrReload`
→ `pm2 save`. Без даунтайма: старая статика отдаётся до конца сборки, бэкенд
перезапускается за доли секунды.

### Проверка после обновления

```bash
pm2 status                                              # veplay → online
curl -sI https://play.vegroove.tech | head -1           # 200
curl -sI http://play.vegroove.tech  | head -1           # 308 → https
curl -s  https://play.vegroove.tech/auth/me             # {"error":"Unauthorized"} — API жив
```

Что новая сборка реально доехала до браузера, видно по имени бандла:

```bash
curl -s https://play.vegroove.tech | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Оно должно совпадать с тем, что вывел `vite build`, и меняться от сборки к сборке.

### Откат

```bash
cd /opt/veplay/app
git log --oneline -5            # выбрать предыдущий коммит
git checkout -B main <коммит>
npm ci && npm run build
pm2 reload veplay
```

Перед рискованным обновлением можно снять снимок каталога:

```bash
tar czf /root/veplay-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
    --exclude=node_modules -C /opt/veplay app
```

Восстановление — распаковать поверх `/opt/veplay` и `pm2 reload veplay`.

---

## Установка с нуля (новый сервер)

### 0. DNS — до всего остального

`play.vegroove.tech` должен быть `A`-записью на IP сервера. Пока домен смотрит
куда-то ещё (например, CNAME на Vercel), Caddy **не получит сертификат**
Let's Encrypt.

```bash
dig +short play.vegroove.tech        # → IP сервера
```

### 1. Базовая система

```bash
apt update && apt -y upgrade
apt -y install git curl ufw

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

### 2. Node 24 + pm2

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt -y install nodejs
node -v                      # v24.x
npm install -g pm2
```

### 3. Caddy

```bash
apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy
```

### 4. Каталоги и код

```bash
# данные вне репозитория — переживают любой redeploy
mkdir -p /var/vegroove/music
chmod 750 /var/vegroove

# код
mkdir -p /opt/veplay
git clone https://github.com/txtbyvova-ui/VEplay_front.git /opt/veplay/app
cd /opt/veplay/app
npm ci
npm run build                # tsc -b && vite build → dist/
```

Отдельный `.env` для сборки **не нужен**: в репозитории лежит `.env.production`
с пустым `VITE_API_BASE`, и фронт ходит относительными путями на тот же домен
через Caddy. Проверить, что в бандле не осталось `localhost`:

```bash
grep -c 'localhost:3001' dist/assets/index-*.js     # → 0
```

### 5. Первый запуск бэкенда

Пароль первого администратора задаётся **только при самом первом старте** (иначе
будет `admin`/`admin`, сервер напишет об этом в лог, а UI будет требовать смену).

```bash
cd /opt/veplay/app
MUSIC_ROOT=/var/vegroove/music DATA_DIR=/var/vegroove \
ADMIN_USER=admin ADMIN_PASS='ВАШ_НАДЁЖНЫЙ_ПАРОЛЬ' node server.mjs
# в логе "Seeded default admin" → Ctrl+C
```

Дальше под pm2 + автозапуск после ребута:

```bash
pm2 startOrReload deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root
# выполнить команду, которую выведет pm2 startup
```

### 6. Caddy

```bash
cp /opt/veplay/app/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Сертификат Let's Encrypt и редирект http→https Caddy делает сам.

### 7. Проверка

Команды — из раздела «Проверка после обновления» выше, плюс:

```bash
reboot                       # после ребута pm2 должен поднять veplay сам
```

Дальше — зайти под админом, создать первого клиента (папка, логин и одноразовый
пароль создаются автоматически; там же выбирается режим — «по времени суток» или
«единый плейлист») и загрузить аудио.

---

## VEclassify (автораскладка папки по времени суток) — опционально

**На боевом сервере сейчас НЕ развёрнут.** `CLASSIFY_PYTHON` / `CLASSIFY_SCRIPT`
в `ecosystem.config.cjs` на него указывают, но каталога нет, поэтому кнопка
«Классифицировать папку» в админке уходит в статус `error`. Остальной функционал
от этого не страдает — треки грузятся вручную по категориям.

Чтобы включить:

```bash
apt -y install python3.12 python3.12-venv ffmpeg libsndfile1

git clone <repo-VEclassify> /opt/veplay/VEclassify     # сосед каталога app
cd /opt/veplay/VEclassify
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt              # librosa, mutagen, google-genai, …

cp .env.example .env
sed -i 's|^GEMINI_API_KEY=.*|GEMINI_API_KEY=ВАШ_КЛЮЧ|' .env    # квота должна быть рабочей
```

Проверка моста:

```bash
.venv/bin/python classify_stage.py --folder /path/с/mp3 --json | head -c 200
# нет папки/ключа/пусто → exit 1 с сообщением в stderr; успех → {"tracks":[...]}
```

Staging загрузок — `MUSIC_ROOT/_incoming/<batchId>/` (временное, сервер чистит
сам); состояние батчей — `DATA_DIR/pending_batches.json`. Оба в `.gitignore`.

---

## Почему под root (и как это исправить потом)

Исторически код заливали на сервер копированием с рабочей машины, а процесс
подняли от `root` — отдельного пользователя приложения так и не появилось. Это
работает, но лишняя привилегия: скомпрометированный бэкенд получает весь сервер.

Миграция, когда дойдут руки (делать в окно обслуживания):

```bash
useradd -m -s /bin/bash veplay
chown -R veplay:veplay /opt/veplay /var/vegroove
pm2 delete veplay                                    # снять с root
su - veplay -c 'cd /opt/veplay/app && pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save'
pm2 startup systemd -u veplay --hp /home/veplay      # от root, затем выполнить выведенную команду
systemctl disable pm2-root
```

После этого все команды из этого документа выполняются через
`sudo -u veplay …`, а `deploy.sh` — как `sudo -u veplay bash /opt/veplay/app/deploy/deploy.sh`.

---

## Заметки

- Бэкенд слушает только `127.0.0.1:3001` — снаружи доступен исключительно через Caddy.
- Rate-limit на `/auth/login`: 10 попыток / 15 минут с одного IP; реальный IP берётся
  из `X-Forwarded-For` только для соединений с localhost (то есть от Caddy).
- Лимиты загрузки: **ручная** (по категории) — форматы `.mp3 .wav .flac .m4a .aac .ogg
  .opus`, ≤ 200 МБ/файл, лимита на количество файлов за раз нет (каждый файл
  принимается или отклоняется отдельно, отклонённые перечислены в ответе);
  **классификатор папки** — только `.mp3`, до 500 файлов и `MAX_UPLOAD_BYTES`
  (дефолт 2 ГБ) на батч, время запроса ограничено `REQUEST_TIMEOUT_MS` (дефолт 1 ч —
  поднят с Node-дефолта 300 с, который давал 408 на больших/медленных загрузках).
- Классификация зависит от квоты Gemini-ключа: при 429/невалидном ключе батч
  корректно уходит в статус `error` (сервер жив), а не виснет.
- **Бэкап** = скопировать `/var/vegroove` целиком (users.json, .secret,
  pending_batches.json, музыка). Код бэкапить не нужно — он в git.
- На той же машине живут посторонние сервисы (`/opt/neurozabelin`, `xray` на
  портах 10808/10809) — к VEplay отношения не имеют, не трогать.
