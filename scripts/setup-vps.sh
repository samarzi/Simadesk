#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  SimaDesk — установка на ВПС. Запускать под root.
#  curl -fsSL https://raw.githubusercontent.com/.../setup-vps.sh | bash
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="samarzi.online"
EMAIL="regstalker05@gmail.com"
REPO="https://github.com/samarzi/Simadesk.git"
APP_DIR="/opt/simadesk"

log() { echo -e "\n\033[1;32m==> $*\033[0m"; }
err() { echo -e "\033[1;31mОШИБКА: $*\033[0m" >&2; exit 1; }

# ── 1. Пакеты ─────────────────────────────────────────────────────────────────
log "[1/7] Установка пакетов"
apt-get update -qq
apt-get install -y -qq git curl docker.io docker-compose-v2 certbot python3 openssl ufw

systemctl enable --now docker

# ── 2. Фаервол ────────────────────────────────────────────────────────────────
log "[2/7] Настройка фаервола"
ufw --force enable
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp

# ── 3. Код ────────────────────────────────────────────────────────────────────
log "[3/7] Клонирование репозитория"
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR" && git pull
else
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# ── 4. .env ───────────────────────────────────────────────────────────────────
log "[4/7] Проверка .env"
[ ! -f "$APP_DIR/.env" ] && err ".env не найден. Скопируй его на сервер:\n  scp .env root@135.106.172.135:/opt/simadesk/.env"

source "$APP_DIR/.env"
[[ "${TELEGRAM_BOT_TOKEN:-}" == "ВСТАВЬ"* ]] && err "Заполни TELEGRAM_BOT_TOKEN в .env"
[[ -z "${JWT_SECRET:-}" ]]                   && err "JWT_SECRET пустой в .env"

# ── 5. SSL ────────────────────────────────────────────────────────────────────
log "[5/7] SSL сертификат (Let's Encrypt)"
mkdir -p "$APP_DIR/ssl"

if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  certbot certonly --standalone --non-interactive --agree-tos \
    --email "$EMAIL" -d "$DOMAIN" -d "www.$DOMAIN"
fi

ln -sf "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "$APP_DIR/ssl/fullchain.pem"
ln -sf "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   "$APP_DIR/ssl/privkey.pem"

# Авто-обновление сертификата
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && docker compose -f $APP_DIR/docker-compose.yml restart nginx") | sort -u | crontab -

# ── 6. Запуск ─────────────────────────────────────────────────────────────────
log "[6/7] Сборка и запуск контейнеров"
cd "$APP_DIR"
docker compose pull
docker compose build
docker compose up -d

# ── 7. Миграции БД ────────────────────────────────────────────────────────────
log "[7/7] Применение миграций базы данных"
echo "   Ждём запуска PostgreSQL..."
for i in $(seq 1 30); do
  docker compose exec -T db pg_isready -U postgres -h localhost &>/dev/null && break
  sleep 2
done

for SQL in "$APP_DIR/migrations"/*.sql; do
  echo "   → $(basename $SQL)"
  docker compose exec -T db psql -U postgres -d postgres < "$SQL" 2>/dev/null || true
done

log "Готово!"
echo ""
echo "  Сайт:     https://${DOMAIN}"
echo "  Логи:     docker compose -f $APP_DIR/docker-compose.yml logs -f"
echo "  Рестарт:  docker compose -f $APP_DIR/docker-compose.yml restart"
