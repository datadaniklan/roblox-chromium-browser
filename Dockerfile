FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji fonts-noto-cjk ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs home.mjs ./

ENV CHROME_PATH=/usr/bin/chromium
ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.mjs"]
