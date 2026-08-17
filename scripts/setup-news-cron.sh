#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  setup-news-cron.sh — Устанавливает cron для ежедневного сбора новостей МП
#  Запускать с Mac ПОСЛЕ деплоя: bash scripts/setup-news-cron.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VPS="root@135.106.172.135"
SSH_KEY="$HOME/.ssh/simadesk_vps"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no"

log() { echo -e "\n\033[1;32m>>> $*\033[0m"; }
err() { echo -e "\033[1;31mОШИБКА: $*\033[0m" >&2; exit 1; }

log "Настройка cron для сбора новостей МП..."

# Читаем CRON_SECRET из .env на VPS
CRON_SECRET=$($SSH "$VPS" "grep CRON_SECRET /opt/simadesk/.env | cut -d= -f2 | tr -d '\"' | tr -d \"'\"" 2>/dev/null || echo "")
SITE_URL=$($SSH "$VPS" "grep SITE_URL /opt/simadesk/.env | cut -d= -f2 | tr -d '\"' | tr -d \"'\"" 2>/dev/null || echo "http://localhost:80")

if [ -z "$CRON_SECRET" ]; then
  # Генерируем случайный секрет и добавляем в .env
  CRON_SECRET=$(openssl rand -hex 32)
  log "Генерирую CRON_SECRET..."
  $SSH "$VPS" "echo \"CRON_SECRET=${CRON_SECRET}\" >> /opt/simadesk/.env"
  echo "   CRON_SECRET добавлен в .env (перезапусти docker compose после)"
fi

# URL Edge Function
EDGE_URL="${SITE_URL}/functions/v1/telegram-auth/mp-news-fetch"

log "Устанавливаю cron-задачу (ежедневно в 09:00 MSK = 06:00 UTC)..."
$SSH "$VPS" bash <<REMOTE
# Создаём скрипт для вызова edge function
cat > /opt/simadesk/scripts/fetch-mp-news.sh << 'SCRIPT'
#!/bin/bash
EDGE_URL="${EDGE_URL}"
SECRET="${CRON_SECRET}"
LOG="/var/log/simadesk-news.log"

echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Running mp-news-fetch..." >> "\$LOG"

RESPONSE=\$(curl -sS -w "\n%{http_code}" \\
  -X POST "\$EDGE_URL" \\
  -H "Content-Type: application/json" \\
  -H "x-cron-secret: \$SECRET" \\
  --connect-timeout 30 \\
  --max-time 120 \\
  2>&1)

HTTP_CODE=\$(echo "\$RESPONSE" | tail -n1)
BODY=\$(echo "\$RESPONSE" | head -n-1)

echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] HTTP \$HTTP_CODE: \$BODY" >> "\$LOG"

# Ротация лога (оставляем последние 500 строк)
tail -500 "\$LOG" > "\$LOG.tmp" && mv "\$LOG.tmp" "\$LOG"
SCRIPT

chmod +x /opt/simadesk/scripts/fetch-mp-news.sh

# Устанавливаем cron (06:00 UTC = 09:00 MSK)
CRON_LINE="0 6 * * * /opt/simadesk/scripts/fetch-mp-news.sh"
# Удаляем старую запись если есть
crontab -l 2>/dev/null | grep -v "fetch-mp-news" | crontab - || true
# Добавляем новую
(crontab -l 2>/dev/null; echo "\$CRON_LINE") | crontab -
echo "Cron установлен: \$CRON_LINE"
REMOTE

log "Тестовый запуск (может занять 30-60 секунд)..."
RESULT=$($SSH "$VPS" bash -c "
  EDGE_URL='${EDGE_URL}'
  SECRET='${CRON_SECRET}'
  curl -sS -X POST \"\$EDGE_URL\" \\
    -H 'Content-Type: application/json' \\
    -H \"x-cron-secret: \$SECRET\" \\
    --connect-timeout 30 --max-time 120 || echo '{\"error\":\"curl failed\"}'
" 2>&1 || echo '{"error":"ssh failed"}')

log "Результат тестового запуска:"
echo "   $RESULT"

log "Готово!"
echo ""
echo "  Логи cron: ssh root@135.106.172.135 'tail -f /var/log/simadesk-news.log'"
echo "  Расписание: ежедневно в 09:00 МСК (06:00 UTC)"
echo ""
echo "  ВАЖНО: Добавь в /opt/simadesk/.env на VPS:"
echo "    OPENROUTER_KEY=sk-or-v1-xxx  (ключ для AI-суммаризации)"
echo "  Затем перезапусти: docker compose up -d --force-recreate edge-runtime"
