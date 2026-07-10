#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  migrate-data.sh — перенос данных из Supabase Cloud → ВПС
#  Запускать с Mac: bash scripts/migrate-data.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VPS="root@135.106.172.135"
APP_DIR="/opt/simadesk"

# Supabase Cloud
CLOUD_HOST="db.db.simadesk.ru"
CLOUD_PORT="5432"
CLOUD_USER="postgres"
CLOUD_DB="postgres"
DUMP_FILE="/tmp/simadesk-backup-$(date +%Y%m%d-%H%M%S).sql"

log() { echo -e "\n\033[1;32m>>> $*\033[0m"; }
err() { echo -e "\033[1;31mОШИБКА: $*\033[0m" >&2; exit 1; }

# Проверяем что pg_dump установлен
if ! command -v pg_dump &>/dev/null; then
  echo "pg_dump не найден. Устанавливаю через brew..."
  brew install libpq
  export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
fi

# ── Запрашиваем пароль от Cloud Supabase ────────────────────────────────────
echo ""
echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  Нужен пароль от Supabase Cloud базы данных.               │"
echo "│  Найти: Supabase Dashboard → Settings → Database →         │"
echo "│         Database Password                                   │"
echo "└─────────────────────────────────────────────────────────────┘"
echo ""
read -rsp "Введи пароль (не будет виден на экране): " CLOUD_PASS
echo ""

log "[1/4] Создание дампа из Supabase Cloud"
echo "   Подключаюсь к ${CLOUD_HOST}..."

PGPASSWORD="$CLOUD_PASS" pg_dump \
  --host="$CLOUD_HOST" \
  --port="$CLOUD_PORT" \
  --username="$CLOUD_USER" \
  --dbname="$CLOUD_DB" \
  --no-owner \
  --no-acl \
  --schema=public \
  --schema=storage \
  --exclude-table-data="auth.*" \
  --exclude-schema=pg_catalog \
  --exclude-schema=information_schema \
  --exclude-schema=pg_toast \
  --exclude-schema=realtime \
  --exclude-schema=server_migrations \
  --format=plain \
  --file="$DUMP_FILE" 2>/dev/null || \
PGPASSWORD="$CLOUD_PASS" pg_dump \
  --host="$CLOUD_HOST" \
  --port="$CLOUD_PORT" \
  --username="$CLOUD_USER" \
  --dbname="$CLOUD_DB" \
  --no-owner \
  --no-acl \
  --schema=public \
  --format=plain \
  --file="$DUMP_FILE"

SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
echo "   Дамп создан: $DUMP_FILE ($SIZE)"

log "[2/4] Копирование дампа на ВПС"
scp "$DUMP_FILE" "$VPS":/tmp/simadesk-restore.sql
echo "   Скопировано на ВПС"

log "[3/4] Восстановление данных на ВПС"
echo "   Ждём готовности PostgreSQL..."
for i in $(seq 1 20); do
  ssh "$VPS" "docker compose -f $APP_DIR/docker-compose.yml exec -T db pg_isready -U postgres" &>/dev/null && break
  sleep 3
done

ssh "$VPS" bash <<REMOTE
set -euo pipefail
echo "   Загружаем данные..."
docker compose -f $APP_DIR/docker-compose.yml exec -T db \
  psql -U postgres -d postgres < /tmp/simadesk-restore.sql 2>/dev/null || \
docker compose -f $APP_DIR/docker-compose.yml exec -T db \
  psql -U postgres -d postgres -f /tmp/simadesk-restore.sql || true
rm -f /tmp/simadesk-restore.sql
echo "   Готово"
REMOTE

log "[4/4] Очистка"
rm -f "$DUMP_FILE"

echo ""
echo "════════════════════════════════════════════"
echo "  Данные перенесены на ВПС!"
echo "  Проверь: https://simadesk.ru"
echo "════════════════════════════════════════════"
