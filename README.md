# Loop Gateway

An agentic AI loop gateway with multi-channel messaging support, container isolation, autonomous task execution, and a real-time web dashboard.

Loop Gateway connects messaging platforms (Telegram, WhatsApp, Email) to Claude AI and runs agent interactions through a managed pipeline with conversation tracking, token usage analytics, and optional OS-level container isolation.

## Features

- **Multi-Channel Messaging** -- Telegram, WhatsApp (via Baileys), and Email (IMAP/SMTP) adapters
- **Container Isolation** -- Run each agent call in an isolated Docker container (nanoclaw pattern: secrets via stdin, no network leaks)
- **Loop Mode** -- Autonomous task execution with prompt files (ralph-wiggum pattern: plan/build loops)
- **Usage Analytics** -- Per-call token tracking, cost estimation, daily/model breakdowns
- **Auth & Rate Limiting** -- Session-based login, admin setup flow, IP-based rate limiting
- **Real-time Dashboard** -- WebSocket-powered live activity feed, channel management, task monitoring
- **SQLite Persistence** -- All data (messages, runs, usage, sessions) in a single portable database

## Quick Start

### 1. Clone and configure

```bash
git clone <repo-url> loop-gateway
cd loop-gateway
cp .env.example .env
# Edit .env and set your ANTHROPIC_API_KEY
```

### 2. Run with Docker (recommended)

```bash
docker compose up -d
```

Open `http://localhost:3000` -- the first visit will prompt you to create an admin account.

### 3. Run locally (development)

```bash
npm install
npm run dev
```

## Common Commands

| Command | Description |
|---------|-------------|
| `docker compose up -d` | Start the gateway in background |
| `docker compose down` | Stop the gateway |
| `docker compose logs -f gateway` | View live logs |
| `docker compose up -d --build` | Rebuild and restart after code changes |
| `npm run dev` | Start in development mode with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Start the compiled production build |

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Messaging Channels                              │
│  (Telegram, WhatsApp, Email)                     │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  Channel Manager                                 │
│  - Adapter lifecycle, message routing            │
│  - Whitelist filtering per channel               │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  Agent Loop                                      │
│  - Direct mode: API call in-process              │
│  - Container mode: isolated Docker per call      │
│  - Token usage logging                           │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  SQLite Database                                 │
│  - Conversations, messages, agent runs           │
│  - API call log, usage analytics                 │
│  - Users, sessions, rate limits                  │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  Web Dashboard (Express + WebSocket)             │
│  - Real-time event stream                        │
│  - Channel management                            │
│  - Usage analytics                               │
│  - Loop task management                          │
└──────────────────────────────────────────────────┘
```

## Container Isolation Mode

For high-security setups, each agent call can run in its own Docker container. The API key is passed via stdin (never on disk or in env vars), and containers run with memory/CPU limits.

### Enable container isolation

```bash
# 1. Build the agent runner image
docker build -t loop-gateway-agent:latest ./agent-runner

# 2. Set environment variable
echo "AGENT_CONTAINER_MODE=true" >> .env

# 3. Restart the gateway
docker compose up -d --build
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_CONTAINER_MODE` | `false` | Enable container isolation |
| `MAX_CONCURRENT_CONTAINERS` | `3` | Max parallel agent containers |
| `CONTAINER_TIMEOUT_MS` | `600000` | Container timeout (10 min) |

## Loop Mode (Autonomous Tasks)

Create tasks that run in an autonomous loop. The agent reads a prompt, produces output, and repeats -- building on previous output each iteration -- until it signals completion or hits the iteration limit.

### Via the Web UI

1. Go to the **Loop Tasks** tab
2. Click **+ New Task**
3. Enter a name, prompt, and max iterations
4. The task starts automatically

### Via the API

```bash
# Create and start a loop task
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "plan_feature",
    "prompt": "Create a detailed implementation plan for user authentication with OAuth2...",
    "maxIterations": 5
  }'

# Check task status
curl http://localhost:3000/api/tasks \
  -H "Authorization: Bearer YOUR_TOKEN"

# Stop a running task
curl -X POST http://localhost:3000/api/tasks/1/stop \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## API Reference

All endpoints require authentication (session token) unless the system is in setup mode.

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/status` | Check if setup is required |
| POST | `/api/auth/setup` | Create initial admin account |
| POST | `/api/auth/login` | Login, returns session token |
| POST | `/api/auth/logout` | Invalidate current session |

### Channels

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/channels` | List all channels with status |
| POST | `/api/channels` | Create a new channel |
| PUT | `/api/channels/:id` | Update channel config |
| DELETE | `/api/channels/:id` | Delete a channel |

### Usage Analytics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/usage` | Overall usage summary + cost |
| GET | `/api/usage/daily` | Daily token breakdown |
| GET | `/api/usage/models` | Usage grouped by model |
| GET | `/api/usage/calls` | Recent individual API calls |

### Loop Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List all loop tasks |
| POST | `/api/tasks` | Create and start a task |
| POST | `/api/tasks/:id/start` | Restart a stopped task |
| POST | `/api/tasks/:id/stop` | Stop a running task |
| GET | `/api/tasks/:id/output` | Get task output |
| DELETE | `/api/tasks/:id` | Delete a task |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/runs` | Recent agent runs |
| GET | `/api/health` | Health check + uptime |

## Adding Channels

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram
2. In the Web UI, click **+ Add Channel** > Telegram
3. Paste the bot token
4. Optionally add allowed user IDs for access control

### WhatsApp

1. In the Web UI, click **+ Add Channel** > WhatsApp
2. A QR code will appear -- scan it with WhatsApp on your phone
3. Messages to the connected WhatsApp number will be processed by the agent

### Email

1. In the Web UI, click **+ Add Channel** > Email
2. Enter IMAP and SMTP credentials
3. The gateway polls for new emails and replies via SMTP

## Project Structure

```
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Environment configuration
│   ├── agent/
│   │   ├── loop.ts           # Agent loop (direct + container modes)
│   │   ├── container-runner.ts  # Docker container spawning
│   │   └── loop-mode.ts      # Autonomous task loop
│   ├── auth/
│   │   └── middleware.ts      # Session auth, rate limiting
│   ├── channels/
│   │   ├── base.ts           # Abstract channel adapter
│   │   ├── manager.ts        # Channel lifecycle + routing
│   │   ├── telegram.ts       # Telegram adapter
│   │   ├── whatsapp.ts       # WhatsApp adapter (Baileys)
│   │   └── email.ts          # Email adapter (IMAP/SMTP)
│   ├── db/
│   │   └── sqlite.ts         # Database schema + queries
│   └── gateway/
│       ├── server.ts          # Express + WebSocket server
│       └── api.ts             # REST API routes
├── agent-runner/              # Isolated agent Docker image
│   ├── Dockerfile
│   ├── package.json
│   └── runner.js             # Stdin/stdout agent runner
├── ui/
│   └── index.html            # Single-page web dashboard
├── docker-compose.yml
├── Dockerfile
├── system-prompt.md          # Default agent system prompt
└── .env.example              # Configuration template
```

## Security Notes

- **Auth**: The first visitor creates the admin account. All subsequent API requests require a session token.
- **Rate Limiting**: 120 requests per minute per IP on API endpoints.
- **Container Isolation**: When enabled, the API key never touches disk -- it's passed via stdin. Containers run with `--read-only`, memory limits, and CPU caps.
- **Channel Whitelists**: Telegram and Email adapters support sender whitelists for access control.
- **Credentials**: All secrets stay in `.env` (never committed). The `.gitignore` excludes `.env` and `/data/`.

## License

MIT
