FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Runtime ---
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (needed for container isolation mode)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.4.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    || echo "Docker CLI install skipped (optional for container mode)"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY ui/ ./ui/

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
