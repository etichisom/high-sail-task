# One image for the API (web app included) and the worker; docker-compose.prod.yml picks the command.
FROM node:26-bookworm-slim

# pdftoppm/pdfinfo (vision page images) and unzip (ZIP uploads)
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not reinstall them
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY tsconfig.json ./
COPY src ./src
COPY db ./db
COPY web ./web
RUN npm --prefix web run build

ENV NODE_ENV=production \
    STORE_DIR=/data/store \
    MODEL_CACHE_DIR=/data/store/models \
    API_PORT=3000 \
    COOKIE_SECURE=true
EXPOSE 3000
CMD ["npx", "tsx", "src/api/server.ts"]
