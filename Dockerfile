FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV PORT=7860 CACHE_DIR=/tmp/cache
EXPOSE 7860
USER node
CMD ["node", "src/server.js"]
