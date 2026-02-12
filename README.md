# OpenCord

Discord bot that provisions [Daytona](https://daytona.io) sandboxes running [OpenCode](https://opencode.ai) sessions. Each Discord thread gets its own isolated sandbox with full conversational context.

## How It Works

1. Mention the bot in an allowed channel
2. Bot creates a Discord thread and provisions a Daytona sandbox
3. OpenCode runs inside the sandbox, responding to messages in the thread
4. Inactive threads pause their sandbox automatically; activity resumes them
5. Conversational context is preserved across bot restarts

## Quick Start

```bash
bun install
cp .env.example .env
# Fill in required values in .env
bun run db:init
bun run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Watch mode |
| `bun run start` | Production run |
| `bun run db:init` | Initialize/migrate database |
| `bun run typecheck` | TypeScript checks |
| `bun run build` | Bundle for deployment |
| `bun run check` | Typecheck + build |

## Configuration

See [`.env.example`](.env.example) for all available environment variables. Required:

- `DISCORD_TOKEN` — Discord bot token
- `DATABASE_URL` — Neon Postgres connection string
- `DAYTONA_API_KEY` — Daytona API key
- `OPENCODE_ZEN_API_KEY` — OpenCode API key

## Health Endpoints

- `GET /healthz` — Liveness check (uptime, Discord status, active sessions)
- `GET /readyz` — Readiness check (200 when Discord connected, 503 otherwise)

## Architecture

```
Discord thread
  └─ message-create handler
       └─ SandboxManager.resolveSessionForMessage()
            ├─ active? → health check → reuse
            ├─ paused? → daytona.start() → restart opencode → reattach session
            └─ missing? → create sandbox → clone repo → start opencode → new session
```

Sessions are persisted in Neon Postgres. Sandbox filesystem (including OpenCode session state) survives pause/resume cycles via Daytona stop/start.
