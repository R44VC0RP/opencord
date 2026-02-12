import { getSql } from "./client";
import { logger } from "../observability/logger";

const PREFIX = "[db]";

export async function initializeDatabase(): Promise<void> {
  const sql = getSql();

  await sql`CREATE TABLE IF NOT EXISTS discord_sessions (
    thread_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    preview_url TEXT NOT NULL,
    preview_token TEXT,
    status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'pausing', 'paused', 'resuming', 'destroying', 'destroyed', 'error')),
    last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pause_requested_at TIMESTAMPTZ,
    paused_at TIMESTAMPTZ,
    resume_attempted_at TIMESTAMPTZ,
    resumed_at TIMESTAMPTZ,
    destroyed_at TIMESTAMPTZ,
    last_health_ok_at TIMESTAMPTZ,
    last_error TEXT,
    resume_fail_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS preview_token TEXT`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS pause_requested_at TIMESTAMPTZ`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS resume_attempted_at TIMESTAMPTZ`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMPTZ`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS destroyed_at TIMESTAMPTZ`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS last_health_ok_at TIMESTAMPTZ`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS last_error TEXT`;
  await sql`ALTER TABLE discord_sessions ADD COLUMN IF NOT EXISTS resume_fail_count INTEGER NOT NULL DEFAULT 0`;

  await sql`ALTER TABLE discord_sessions DROP CONSTRAINT IF EXISTS discord_sessions_status_check`;
  await sql`ALTER TABLE discord_sessions
    ADD CONSTRAINT discord_sessions_status_check
    CHECK (status IN ('creating', 'active', 'pausing', 'paused', 'resuming', 'destroying', 'destroyed', 'error'))`;

  await sql`CREATE INDEX IF NOT EXISTS discord_sessions_status_last_activity_idx
    ON discord_sessions (status, last_activity)`;

  await sql`CREATE INDEX IF NOT EXISTS discord_sessions_status_updated_at_idx
    ON discord_sessions (status, updated_at)`;
}

if (import.meta.main) {
  initializeDatabase()
    .then(() => {
      logger.info({ event: "db.schema.ready", component: "db", message: `${PREFIX} Schema is ready` });
    })
    .catch((err) => {
      logger.error({ event: "db.schema.failed", component: "db", message: `${PREFIX} Failed to initialize schema`, error: err });
      process.exit(1);
    });
}
