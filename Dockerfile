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
    git \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (needed for container isolation mode)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.4.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    || echo "Docker CLI install skipped (optional for container mode)"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Install Scrapling for stealth web browsing (replaces Playwright)
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt \
    && scrapling install \
    || echo "Scrapling browser install skipped (web_browse tool will be unavailable)"

COPY --from=builder /app/dist ./dist
COPY scripts/ ./scripts/
COPY ui/ ./ui/

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
