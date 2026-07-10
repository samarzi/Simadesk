#!/bin/bash
# Edge functions деплоятся автоматически через docker-compose.
# Файлы из backend/functions/ монтируются в контейнер edge-runtime как volume.
# Для применения изменений перезапусти контейнер functions:
#   docker compose restart functions
echo "Edge functions монтируются через docker volume."
echo "Для применения изменений: docker compose restart functions"
