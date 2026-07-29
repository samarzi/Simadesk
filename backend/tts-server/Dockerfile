FROM python:3.12-slim
RUN pip install --no-cache-dir edge-tts
WORKDIR /app
COPY server.py .
CMD ["python", "server.py"]
