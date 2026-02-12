# AGENTS.md

Guide for coding agents working in this repository.
Use this file for build/test commands and coding conventions.

## Project Snapshot
- Stack: Bun + TypeScript (ESM, strict mode)
- App: Discord bot that provisions Daytona sandboxes
- Persistence: Neon Postgres (`discord_sessions`)
- Runtime flow: Discord thread -> sandbox -> OpenCode session
- Ops: structured JSON logs + `/healthz` and `/readyz`

## Repository Map
- `src/index.ts`: startup, wiring, graceful shutdown
- `src/config.ts`: env schema and parsing (Zod)
- `src/discord/`: Discord client + handlers + routing logic
- `src/sandbox/`: sandbox lifecycle + OpenCode transport
- `src/sessions/store.ts`: Neon-backed session store
- `src/db/init.ts`: idempotent DB schema initialization
- `src/http/health.ts`: health/readiness HTTP server
- `.env.example`: env contract

## Setup and Run Commands
### Install
- `bun install`

### First-time local setup
- `cp .env.example .env`
- Fill required secrets in `.env`
- Initialize schema: `bun run db:init`

### Development run
- Watch mode: `bun run dev`
- Normal run: `bun run start`
- Dev bootstrap helper: `bun run dev:setup`

### Static checks
- Typecheck: `bun run typecheck`
- Build: `bun run build`
- Combined check: `bun run check`

### Health checks
- `curl -s http://127.0.0.1:8787/healthz`
- `curl -i http://127.0.0.1:8787/readyz`

## Testing Commands
There is no first-party test suite in `src/` yet.
Use Bun test commands for new tests.
- Run all tests (if present): `bun test`
- Run a single test file: `bun test path/to/file.test.ts`
- Run one file in watch mode: `bun test --watch path/to/file.test.ts`
When adding tests, prefer colocated `*.test.ts` near implementation files.

## Cursor / Copilot Rules
Checked these paths:
- `.cursor/rules/`
- `.cursorrules`
- `.github/copilot-instructions.md`
No Cursor/Copilot rule files currently exist in this repo.
If added later, update this file and follow those rules.

## Code Style
### TypeScript and modules
- Keep code strict-TypeScript compatible.
- Use ESM imports/exports only.
- Prefer named exports over default exports.
- Add explicit return types on exported functions.

### Imports
- Group imports as: external first, then internal.
- Use `import type` for type-only imports.
- Keep import paths consistent with existing relative style.

### Formatting
- Match existing style:
  - double quotes
  - semicolons
  - trailing commas where appropriate
- Keep functions small and focused.
- Avoid comments unless logic is non-obvious.

### Naming
- `camelCase`: variables/functions
- `PascalCase`: classes/interfaces/type aliases
- `UPPER_SNAKE_CASE`: env keys and constants
- Log events should be stable (`domain.action.result`).

### Types and contracts
- Reuse shared types from `src/types.ts`.
- Preserve `SessionStatus` semantics when adding new states.
- Prefer `unknown` over `any` at untrusted boundaries.
- Narrow and validate external data before use.

## Error Handling and Logging
- Use `logger` from `src/observability/logger.ts`.
- Do not add raw `console.log` in app paths.
- Include context fields when available:
  - `threadId`
  - `channelId`
  - `guildId`
  - `sandboxId`
  - `sessionId`
- Fail fast on invalid config in `src/config.ts`.
- Wrap network/process operations in contextual `try/catch`.
- Separate recoverable errors from terminal errors.
- Never log secret values.

## Environment and Secrets
- Read env only through `getEnv()`.
- Update `.env.example` for env schema changes.
- Keep auth tokens out of command strings and logs.
- Pass runtime secrets via environment variables.

## Domain-Specific Rules
### Session lifecycle
- Neon mapping (`thread_id`, `sandbox_id`, `session_id`) is authoritative.
- Resume existing sandbox/session before creating replacements.
- Recreate only when sandbox is unavailable/destroyed.
- If session changes, replay Discord thread history as fallback context.

### Daytona behavior
- `stop()` clears running processes but keeps filesystem state.
- `start()` requires process bootstrap (`opencode serve`).
- Keep lifecycle transitions deterministic and observable.

### OpenCode transport
- Keep preview token separate from persisted URL when possible.
- Send token using `x-daytona-preview-token` header.
- Keep retry loops bounded and configurable.

### Discord handler behavior
- Ignore bot/self chatter and respect mention/role gating.
- Preserve thread ownership checks for bot-managed threads.
- Keep outbound messages chunked for Discord size limits.

## Non-Obvious Discoveries

### OpenCode session persistence
- Sessions are disk-persistent JSON files in `~/.local/share/opencode/storage/session/<projectID>/`
- Sessions survive `opencode serve` restarts if filesystem intact AND process restarts from same git repo directory
- Sessions are scoped by `projectID` = git root commit hash (or `"global"` for non-git dirs)
- After `daytona.start()`, processes are guaranteed dead - always restart `opencode serve` immediately, don't wait for health first (`src/sandbox/manager.ts:400-420`)

### Session reattach debugging
- If `sessionExists()` returns false but sandbox filesystem is intact, search by title (`Discord thread <threadId>`) via `listSessions()` - session may exist under different ID due to OpenCode internal state changes
- Thread lock per `threadId` prevents concurrent create/resume races (`src/sandbox/manager.ts:614-632`)
- Never fall back to new sandbox when `daytona.start()` succeeds - filesystem is intact, only OpenCode process needs restart

### Discord + multiple processes
- Multiple bot processes with same `DISCORD_TOKEN` cause race conditions - one succeeds, others fail with `DiscordAPIError[160004]` (thread already created)
- PTY sessions with `exec bash -l` stay alive after command exits, leading to duplicate bot runtimes if not cleaned up

### Sandbox runtime auth
- Pass `GITHUB_TOKEN` as process env to `opencode serve` via `sandbox.process.executeCommand()` `env` parameter
- Never interpolate tokens into command strings - use `env` parameter in `exec()` options (`src/sandbox/manager.ts:27-72`)

## Agent Workflow Checklist
### Before coding
- Read related modules and follow existing patterns.
- Prefer narrow, minimal changes over broad refactors.

### During coding
- Keep behavior backwards-compatible unless intentionally changing it.
- Keep changes cohesive (schema + store + manager together).
- Add/update logs for important lifecycle branches.

### After coding
- Run `bun run typecheck`
- Run `bun run build`
- Run `bun run db:init` for schema-affecting changes
- Smoke-check health endpoints if bootstrap/runtime changed

## Git/PR Safety for Agents
- Do not commit or push unless explicitly requested.
- Do not amend commits unless explicitly requested.
- Avoid destructive git commands unless explicitly requested.
- Summaries should cite changed files and operational impact.
