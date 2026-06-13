#!/bin/bash
# ============================================================
# SimaDesk — деплой Supabase Edge Functions
# ============================================================
# Запускать: chmod +x supabase/deploy.sh && ./supabase/deploy.sh
# ============================================================

set -e

PROJECT_REF="rdqwzojrsmbdxiczqjci"

echo "🚀 SimaDesk — деплой Edge Functions"
echo "======================================"

# 1. Проверить наличие Supabase CLI
if ! command -v supabase &> /dev/null; then
  echo "❌ Supabase CLI не найден."
  echo "   Установить: brew install supabase/tap/supabase"
  exit 1
fi

# 2. Логин (если не авторизован)
echo "🔑 Проверка авторизации Supabase..."
supabase login

# 3. Установить BOT_TOKEN как секрет (запрашиваем интерактивно — НЕ сохраняем в файлах)
echo ""
echo "🤖 Введите токен Telegram-бота (от @BotFather):"
read -s BOT_TOKEN
echo ""

if [ -z "$BOT_TOKEN" ]; then
  echo "❌ Токен не введён, отмена."
  exit 1
fi

echo "📦 Устанавливаем BOT_TOKEN в секреты Supabase..."
supabase secrets set BOT_TOKEN="$BOT_TOKEN" --project-ref "$PROJECT_REF"
BOT_TOKEN=""  # Очищаем из памяти сразу

# 4. Деплой функции
echo "📤 Деплоим telegram-auth..."
supabase functions deploy telegram-auth --project-ref "$PROJECT_REF"

echo ""
echo "✅ Готово!"
echo ""
echo "📋 Следующий шаг — настройка домена в @BotFather:"
echo "   1. Откройте @BotFather в Telegram"
echo "   2. /mybots → simadesk_bot → Bot Settings → Domain"
echo "   3. Введите домен (например: simadesk.io или ваш Netlify URL)"
echo "   4. Для локальной разработки используйте VITE_DEV_AUTH=true в .env"
