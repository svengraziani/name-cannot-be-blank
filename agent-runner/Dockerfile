FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /agent

COPY package.json ./
RUN npm install --omit=dev

COPY runner.js ./

# Agent receives input via stdin, outputs via stdout
# No secrets on disk or in env vars
CMD ["node", "runner.js"]
