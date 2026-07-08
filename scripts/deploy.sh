#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  deploy.sh — деплой SimaDesk на ВПС без GitHub
#  Запускать с Mac: bash scripts/deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VPS="root@135.106.172.135"
APP_DIR="/opt/simadesk"
DOMAIN="samarzi.online"
EMAIL="regstalker05@gmail.com"

log() { echo -e "\n\033[1;32m>>> $*\033[0m"; }
err() { echo -e "\033[1;31mОШИБКА: $*\033[0m" >&2; exit 1; }

cd "$(dirname "$0")/.."

# ── Проверки перед деплоем ────────────────────────────────────────────────────
[ ! -f ".env" ] && err ".env не найден"
source .env
[[ "${TELEGRAM_BOT_TOKEN:-}" == "ВСТАВЬ"* ]] && err "Заполни TELEGRAM_BOT_TOKEN в .env"
[[ -z "${JWT_SECRET:-}" ]] && err "JWT_SECRET пустой в .env"

command -v docker &>/dev/null || err "Docker не установлен на Mac. Скачай с https://docs.docker.com/desktop/mac/"
command -v ssh    &>/dev/null || err "SSH не найден"

# ── Локальная сборка Docker образа ───────────────────────────────────────────
log "[1/6] Сборка Docker образа фронтенда"
docker build \
  --build-arg VITE_SUPA_URL="https://${DOMAIN}" \
  --build-arg VITE_SUPA_KEY="${ANON_KEY}" \
  --build-arg VITE_TG_BOT_USERNAME="${TELEGRAM_BOT_USERNAME}" \
  --build-arg VITE_DEV_AUTH="false" \
  -t simadesk-frontend:latest .

log "[2/6] Экспорт образа в архив"
docker save simadesk-frontend:latest | gzip > /tmp/simadesk-frontend.tar.gz
echo "   Размер: $(du -sh /tmp/simadesk-frontend.tar.gz | cut -f1)"

# ── Подготовка ВПС ───────────────────────────────────────────────────────────
log "[3/6] Установка пакетов на ВПС"
ssh "$VPS" bash <<'REMOTE'
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 certbot ufw curl
systemctl enable --now docker
ufw --force enable
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
mkdir -p /opt/simadesk/ssl /opt/simadesk/supabase/functions /opt/simadesk/migrations
REMOTE

# ── Копирование файлов ────────────────────────────────────────────────────────
log "[4/6] Копирование файлов на ВПС"
scp /tmp/simadesk-frontend.tar.gz "$VPS":/tmp/
scp .env                           "$VPS":"$APP_DIR/.env"
scp docker-compose.yml             "$VPS":"$APP_DIR/docker-compose.yml"
scp nginx.conf                     "$VPS":"$APP_DIR/nginx.conf"
scp nginx-internal.conf            "$VPS":"$APP_DIR/nginx-internal.conf"
scp -r migrations/                 "$VPS":"$APP_DIR/"
scp -r supabase/functions/         "$VPS":"$APP_DIR/supabase/"

# ── SSL + запуск ─────────────────────────────────────────────────────────────
log "[5/6] SSL и запуск контейнеров на ВПС"
ssh "$VPS" bash <<REMOTE
set -euo pipefail
cd $APP_DIR

# Загрузить образ фронтенда
docker load < /tmp/simadesk-frontend.tar.gz
rm /tmp/simadesk-frontend.tar.gz

# SSL сертификат — запускаем временный nginx на 80 порту если не занят
if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  certbot certonly --standalone --non-interactive --agree-tos \
    --email "${EMAIL}" -d "${DOMAIN}" -d "www.${DOMAIN}" || \
  echo "ВНИМАНИЕ: SSL не получен. DNS ещё не обновился — запусти скрипт снова через час."
fi

if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  ln -sf "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "$APP_DIR/ssl/fullchain.pem"
  ln -sf "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   "$APP_DIR/ssl/privkey.pem"
fi

# Авто-обновление сертификата
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && docker compose -f $APP_DIR/docker-compose.yml restart nginx") | sort -u | crontab -

# Запуск
docker compose pull --quiet
docker compose up -d
REMOTE

# ── Миграции БД ──────────────────────────────────────────────────────────────
log "[6/6] Применение миграций базы данных"
echo "   Ждём запуска PostgreSQL (до 60 сек)..."
for i in $(seq 1 30); do
  ssh "$VPS" "docker compose -f $APP_DIR/docker-compose.yml exec -T db pg_isready -U postgres" &>/dev/null && break
  sleep 2
done

for SQL in migrations/*.sql; do
  echo "   → $(basename $SQL)"
  ssh "$VPS" "docker compose -f $APP_DIR/docker-compose.yml exec -T db psql -U postgres -d postgres" < "$SQL" 2>/dev/null || true
done

rm -f /tmp/simadesk-frontend.tar.gz

log "Готово!"
echo ""
echo "  Сайт:     https://${DOMAIN}"
echo "  Статус:   ssh ${VPS} 'docker compose -f ${APP_DIR}/docker-compose.yml ps'"
echo "  Логи:     ssh ${VPS} 'docker compose -f ${APP_DIR}/docker-compose.yml logs -f'"
