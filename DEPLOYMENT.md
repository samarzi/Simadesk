# Deployment Guide — SimaDesk

**Стек:** Self-hosted VPS (Docker Compose + Nginx + PostgreSQL)

## Деплой через CI/CD (GitHub Actions)

При пуше в `main` автоматически:
1. Type-check (`tsc --noEmit`)
2. Tests (`vitest`)
3. Build (`vite build`)
4. SCP дистрибутива на VPS → reload nginx

Секреты хранятся в GitHub Secrets:
- `VPS_HOST` — IP сервера
- `VPS_SSH_KEY` — SSH приватный ключ
- `VITE_API_URL`, `VITE_API_KEY`, `VITE_TG_BOT_USERNAME` — env vars для билда

## Ручной деплой

```bash
# 1. Собрать
npm run build

# 2. Загрузить на VPS
scp -r dist/* root@135.106.172.135:/opt/simadesk/dist/

# 3. Перезагрузить nginx
ssh root@135.106.172.135 "cd /opt/simadesk && docker compose exec -T nginx nginx -s reload"
```

## Деплой 전체 стека (Docker Compose)

```bash
ssh root@135.106.172.135
cd /opt/simadesk

# Обновить код
git pull

# Пересобрать фронтенд
docker compose build --no-cache frontend

# Перезапустить все сервисы
docker compose up -d
```

## Сервисы

| Сервис | Порт | Описание |
|--------|------|----------|
| nginx | 80, 443 | Gateway: SSL + проксирование |
| frontend | внутренний | Nginx + Vite SPA |
| rest | 3000 | PostgREST (Supabase REST API) |
| auth | 9999 | GoTrue (авторизация) |
| functions | 9000 | Edge Runtime (telegram-auth и др.) |
| storage | 5000 | Supabase Storage API |
| realtime | 4000 | Supabase Realtime |
| db | 5432 | PostgreSQL 15 |
| imgproxy | 8080 | Трансформация изображений |

## Environment Variables

Все переменные в `/opt/simadesk/.env` на VPS. См. `.env.example` для шаблона.

**Критичные секреты (НЕ в git):**
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `ANON_KEY` / `SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `REALTIME_ENC_KEY` / `REALTIME_SECRET_KEY_BASE`

## Troubleshooting

**Nginx не стартует:**
```bash
docker compose logs nginx
# Часто: realtime контейнер упал → nginx Depends на него
docker compose up -d realtime
docker compose up -d nginx
```

**404 на API:**
```bash
# Проверить что PostgREST работает
curl -H "apikey: <ANON_KEY>" http://localhost/rest/v1/boxes?select=id | head
```

**SSL истёк:**
```bash
# Certbot автоматический ренев:
docker compose exec certbot certbot renew
docker compose exec nginx nginx -s reload
```
