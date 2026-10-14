FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg nodejs npm \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN pip install --no-cache-dir "aiohttp>=3.9,<4" "cryptography>=42" \
 && npm install --omit=dev --no-audit --no-fund ws@8
COPY server.py replay.js /app/
COPY static /app/static
ENV PYTHONUNBUFFERED=1 DATA_DIR=/data PORT=8090
VOLUME /data
EXPOSE 8090
CMD ["python", "/app/server.py"]
