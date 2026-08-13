# SimaDesk — инструкции для Claude

## Деплой на VPS

**ВСЕГДА** использовать только этот скрипт:

```bash
bash scripts/deploy.sh
```

Никогда не деплоить вручную через rsync/ssh/docker напрямую.

Скрипт:
1. Проверяет незакоммиченные изменения
2. Синхронизирует код в `/opt/simadesk/` (правильный путь)
3. Собирает Docker образ с нужными build-args из `.env` VPS
4. Перезапускает контейнер с `--force-recreate`
5. Применяет SQL-миграции

VPS: `root@135.106.172.135`, ключ: `~/.ssh/simadesk_vps`
Рабочий каталог на VPS: `/opt/simadesk/` (не `/root/simadesk/`)

## Стек

- Vanilla TypeScript SPA, сборка Vite
- Модули регистрируются на `window.*Module`
- CSS: CSS-переменные (`var(--text)`, `var(--bg2)`, `var(--border)` и т.д.)
- Backend: Supabase (PostgreSQL + GoTrue + PostgREST)
