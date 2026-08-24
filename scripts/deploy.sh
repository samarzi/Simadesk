#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  deploy.sh — деплой SimaDesk на ВПС
#  Запускать с Mac: bash scripts/deploy.sh
#
#  Как работает:
#    1. Синхронизирует исходный код на VPS через rsync
#    2. Собирает Docker образ фронтенда прямо на VPS (использует .env с VPS)
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

# ── Синхронизация исходного кода ──────────────────────────────────────────────
log "[1/5] Синхронизация кода на ВПС"
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

# ── Сборка фронтенда на VPS ───────────────────────────────────────────────────
log "[2/5] Сборка Docker образа фронтенда на ВПС"
$SSH "$VPS" bash <<REMOTE
set -euo pipefail
cd $APP_DIR

# Читаем ключи из .env на VPS
set -a; source .env; set +a

docker build \\
  --build-arg VITE_API_URL="\${SITE_URL}" \\
  --build-arg VITE_API_KEY="\${ANON_KEY}" \\
  --build-arg VITE_TG_BOT_USERNAME="\${TELEGRAM_BOT_USERNAME}" \\
  --build-arg VITE_YANDEX_CLIENT_ID="\${YANDEX_CLIENT_ID:-}" \\
  --build-arg VITE_DEV_AUTH="false" \\
  -t simadesk-frontend:latest .
REMOTE

# ── Перезапуск фронтенда и edge functions ────────────────────────────────────
log "[3/5] Перезапуск frontend и functions контейнеров"
$SSH "$VPS" "cd $APP_DIR && docker compose up -d --no-deps --force-recreate frontend functions"

# ── Применение конфига nginx ─────────────────────────────────────────────────
# nginx.conf монтируется в контейнер ОДНИМ ФАЙЛОМ (./nginx.conf:/etc/nginx/nginx.conf).
# rsync заменяет файл через новый inode, поэтому контейнер продолжает видеть
# старую версию, а `nginx -s reload` перечитывает её же. Раньше конфиг
# синхронизировался, но никогда не применялся: правка client_max_body_size
# доехала до сервера и молча не работала. Помогает только пересоздание.
log "[4/5] Применение конфига nginx"
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
log "[5/5] Применение SQL-миграций"
echo "   Ждём PostgreSQL..."
for i in $(seq 1 30); do
  $SSH "$VPS" "docker exec simadesk-db-1 pg_isready -U postgres" &>/dev/null && break
  sleep 2
done

for SQL in migrations/*.sql backend/migrations/*.sql; do
  [ -f "$SQL" ] || continue
  echo "   → $SQL"
  $SSH "$VPS" "docker exec -i simadesk-db-1 psql -U postgres -d postgres" < "$SQL" 2>/dev/null || true
done

log "Готово!"
echo ""
echo "  Сайт:   https://${DOMAIN}"
echo "  Статус: ssh ${VPS} 'docker compose -f ${APP_DIR}/docker-compose.yml ps'"
echo "  Логи:   ssh ${VPS} 'docker compose -f ${APP_DIR}/docker-compose.yml logs -f'"
