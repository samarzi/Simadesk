#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  deploy.sh — деплой SimaDesk на ВПС
#  Запускать с Mac: bash scripts/deploy.sh
#
#  Как работает:
#    1. Собирает фронтенд локально с публичными настройками .env VPS
#    2. Синхронизирует код и готовые файлы на VPS через rsync
#    3. Собирает лёгкий образ nginx (без Node/Vite на VPS)
#    3. Перезапускает frontend контейнер
#    4. Применяет nginx.conf, если он изменился (через пересоздание контейнера)
#    5. Применяет новые SQL-миграции
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VPS="root@135.106.172.135"
SSH_KEY="$HOME/.ssh/simadesk_vps"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no"
RSYNC_SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no"
APP_DIR="/opt/simadesk"
DOMAIN="simadesk.ru"

log() { echo -e "\n\033[1;32m>>> $*\033[0m"; }
err() { echo -e "\033[1;31mОШИБКА: $*\033[0m" >&2; exit 1; }

cd "$(dirname "$0")/.."

command -v rsync &>/dev/null || err "rsync не найден"
command -v ssh   &>/dev/null || err "SSH не найден"
command -v node  &>/dev/null || err "Node.js не найден"
command -v npm   &>/dev/null || err "npm не найден"

# ── Проверка: не деплоить если есть незакоммиченные изменения или сташ ────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  err "Есть незакоммиченные изменения! Сделай 'git add -A && git commit' перед деплоем."
fi
if git stash list | grep -q .; then
  echo -e "\033[1;33mПРЕДУПРЕЖДЕНИЕ: В git stash есть сохранённые изменения:\033[0m"
  git stash list
  echo ""
  read -r -p "Продолжить деплой БЕЗ этих изменений? (y/N): " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || err "Деплой отменён. Примени сташ: git stash pop"
fi

# Only the public browser settings leave the VPS. Never copy its .env or print
# keys. Vite runs locally so a bundle build cannot exhaust the VPS RAM/swap.
log "[1/6] Локальная сборка с настройками VPS"
BUILD_CONFIG=$($SSH "$VPS" bash <<'REMOTE'
set -euo pipefail
cd /opt/simadesk
set -a; source .env; set +a
python3 - <<'PY'
import json, os
print(json.dumps({
    'VITE_API_URL': os.environ['SITE_URL'],
    'VITE_API_KEY': os.environ['ANON_KEY'],
    'VITE_TG_BOT_USERNAME': os.environ['TELEGRAM_BOT_USERNAME'],
    'VITE_YANDEX_CLIENT_ID': os.environ.get('YANDEX_CLIENT_ID', ''),
    'VITE_DEV_AUTH': 'false',
}))
PY
REMOTE
)
[ -d node_modules ] || npm ci
SIMA_BUILD_CONFIG="$BUILD_CONFIG" node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
const config = JSON.parse(process.env.SIMA_BUILD_CONFIG);
if (!config.VITE_API_URL || !config.VITE_API_KEY || config.VITE_DEV_AUTH !== 'false')
  throw new Error('Не получены настройки production');
const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', env: { ...process.env, ...config } });
process.exit(build.status ?? 1);
NODE
unset BUILD_CONFIG

# ── Синхронизация исходного кода ──────────────────────────────────────────────
log "[2/6] Синхронизация кода и готовой сборки на ВПС"
rsync -az --delete \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude 'data/' \
  --exclude 'ssl/' \
  --exclude '*.tar.gz' \
  -e "$RSYNC_SSH" \
  ./ "${VPS}:${APP_DIR}/"
rsync -az --delete -e "$RSYNC_SSH" dist/ "${VPS}:${APP_DIR}/dist/"

# ── Сборка фронтенда на VPS ───────────────────────────────────────────────────
log "[3/6] Сборка лёгкого Docker образа фронтенда на ВПС"
$SSH "$VPS" bash <<REMOTE
set -euo pipefail
cd $APP_DIR

docker build -f Dockerfile.prebuilt -t simadesk-frontend:latest .
REMOTE

# ── Перезапуск фронтенда и edge functions ────────────────────────────────────
log "[4/6] Перезапуск frontend и functions контейнеров"
$SSH "$VPS" "cd $APP_DIR && docker compose up -d --no-deps --force-recreate frontend functions"

# ── Применение конфига nginx ─────────────────────────────────────────────────
# nginx.conf монтируется в контейнер ОДНИМ ФАЙЛОМ (./nginx.conf:/etc/nginx/nginx.conf).
# rsync заменяет файл через новый inode, поэтому контейнер продолжает видеть
# старую версию, а `nginx -s reload` перечитывает её же. Раньше конфиг
# синхронизировался, но никогда не применялся: правка client_max_body_size
# доехала до сервера и молча не работала. Помогает только пересоздание.
log "[5/6] Применение конфига nginx"
HOST_MD5=$($SSH "$VPS" "md5sum $APP_DIR/nginx.conf | cut -d' ' -f1" 2>/dev/null || echo "host")
CONT_MD5=$($SSH "$VPS" "docker exec simadesk-nginx-1 md5sum /etc/nginx/nginx.conf | cut -d' ' -f1" 2>/dev/null || echo "cont")
if [ "$HOST_MD5" = "$CONT_MD5" ]; then
  echo "   Конфиг не изменился"
else
  echo "   Проверка синтаксиса…"
  $SSH "$VPS" "cd $APP_DIR && docker run --rm -v $APP_DIR/nginx.conf:/etc/nginx/nginx.conf:ro nginx:alpine nginx -t" \
    || err "nginx.conf содержит ошибку — конфиг НЕ применён, старый продолжает работать"
  echo "   Пересоздание контейнера nginx…"
  $SSH "$VPS" "cd $APP_DIR && docker compose up -d --force-recreate --no-deps nginx"
fi

# ── Применение новых миграций ─────────────────────────────────────────────────
log "[6/6] Применение SQL-миграций"
echo "   Ждём PostgreSQL..."
for i in $(seq 1 30); do
  $SSH "$VPS" "docker exec simadesk-db-1 pg_isready -U supabase_admin" &>/dev/null && break
  sleep 2
done

# For a release with known schema changes, apply only its migrations. Legacy
# migrations can contain one-off backfills and must not be replayed casually.
if [[ -n "${SIMA_MIGRATIONS:-}" ]]; then
  read -r -a SQL_FILES <<< "$SIMA_MIGRATIONS"
else
  SQL_FILES=(migrations/*.sql backend/migrations/*.sql)
fi
for SQL in "${SQL_FILES[@]}"; do
  [ -f "$SQL" ] || continue
  echo "   → $SQL"
  $SSH "$VPS" "docker exec -i simadesk-db-1 psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1" < "$SQL" \
    || err "Миграция $SQL не применена"
done

# ── Сервер озвучки (edge-tts) — пересобираем, только если менялась его папка ──
TTS_HASH=$(cat backend/tts-server/* | shasum -a 256 | cut -d' ' -f1)
TTS_DEPLOYED=$($SSH "$VPS" "cat /opt/simadesk-tts-server.hash 2>/dev/null" || true)
if [ "$TTS_HASH" != "$TTS_DEPLOYED" ]; then
  log "Пересборка сервера озвучки (tts-server)"
  $SSH "$VPS" "cd $APP_DIR && docker compose build tts-server && docker compose up -d --no-deps --force-recreate tts-server && echo $TTS_HASH > /opt/simadesk-tts-server.hash"
else
  echo "   Сервер озвучки не менялся"
fi

log "Готово!"
echo ""
echo "  Сайт:   https://${DOMAIN}"
echo "  Статус: ssh ${VPS} 'docker compose -f ${APP_DIR}/docker-compose.yml ps'"
echo "  Логи:   ssh ${VPS} 'docker compose -f ${APP_DIR}/docker-compose.yml logs -f'"
