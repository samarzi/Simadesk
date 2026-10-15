FROM python:3.12-slim
# Версия зафиксирована: Microsoft периодически меняет требования к клиенту
# (токен Sec-MS-GEC и версия Edge). 7.2.8 с октября 2026 получает 403,
# 7.3.1 работает. Обновлять осознанно и проверять синтез после деплоя.
RUN pip install --no-cache-dir edge-tts==7.3.1
WORKDIR /app
COPY server.py .
CMD ["python", "-u", "server.py"]
