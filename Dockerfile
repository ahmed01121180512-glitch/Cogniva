FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV NODE_ENV=production TRUST_PROXY=1 PORT=8080 DB_PATH=/data/cogniva.db
EXPOSE 8080
CMD ["node", "server.mjs"]
