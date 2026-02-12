import { getSql } from "../db/client";
import type { SessionInfo, SessionStatus } from "../types";

type SessionRow = {
  thread_id: string;
  channel_id: string;
  guild_id: string;
  sandbox_id: string;
  session_id: string;
  preview_url: string;
  preview_token: string | null;
  status: SessionStatus;
  last_error: string | null;
  resume_fail_count: number;
};

export interface SessionStore {
  upsert(session: SessionInfo): Promise<void>;
  getByThread(threadId: string): Promise<SessionInfo | null>;
  hasTrackedThread(threadId: string): Promise<boolean>;
  getActive(threadId: string): Promise<SessionInfo | null>;
  markActivity(threadId: string): Promise<void>;
  markHealthOk(threadId: string): Promise<void>;
  updateStatus(threadId: string, status: SessionStatus, lastError?: string | null): Promise<void>;
  incrementResumeFailure(threadId: string, lastError: string): Promise<void>;
  listActive(): Promise<SessionInfo[]>;
  listStaleActive(cutoffMinutes: number): Promise<SessionInfo[]>;
  listExpiredPaused(pausedTtlMinutes: number): Promise<SessionInfo[]>;
}

class NeonSessionStore implements SessionStore {
  private readonly sql = getSql();

  async upsert(session: SessionInfo): Promise<void> {
    await this.sql`
      INSERT INTO discord_sessions (
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        last_activity,
        resumed_at,
        created_at,
        updated_at
      ) VALUES (
        ${session.threadId},
        ${session.channelId},
        ${session.guildId},
        ${session.sandboxId},
        ${session.sessionId},
        ${session.previewUrl},
        ${session.previewToken},
        ${session.status},
        ${session.lastError ?? null},
        NOW(),
        CASE WHEN ${session.status} = 'active' THEN NOW() ELSE NULL END,
        NOW(),
        NOW()
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        channel_id = EXCLUDED.channel_id,
        guild_id = EXCLUDED.guild_id,
        sandbox_id = EXCLUDED.sandbox_id,
        session_id = EXCLUDED.session_id,
        preview_url = EXCLUDED.preview_url,
        preview_token = EXCLUDED.preview_token,
        status = EXCLUDED.status,
        last_error = EXCLUDED.last_error,
        last_activity = NOW(),
        resumed_at = CASE WHEN EXCLUDED.status = 'active' THEN NOW() ELSE discord_sessions.resumed_at END,
        updated_at = NOW()
    `;
  }

  async getByThread(threadId: string): Promise<SessionInfo | null> {
    const rows = await this.sql`
      SELECT
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        resume_fail_count
      FROM discord_sessions
      WHERE thread_id = ${threadId}
      LIMIT 1
    ` as SessionRow[];

    if (rows.length === 0) return null;
    return toSessionInfo(rows[0]);
  }

  async hasTrackedThread(threadId: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT thread_id
      FROM discord_sessions
      WHERE thread_id = ${threadId}
      LIMIT 1
    ` as Array<{ thread_id: string }>;

    return rows.length > 0;
  }

  async getActive(threadId: string): Promise<SessionInfo | null> {
    const rows = await this.sql`
      SELECT
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        resume_fail_count
      FROM discord_sessions
      WHERE thread_id = ${threadId}
        AND status = 'active'
      LIMIT 1
    ` as SessionRow[];

    if (rows.length === 0) return null;
    return toSessionInfo(rows[0]);
  }

  async markActivity(threadId: string): Promise<void> {
    await this.sql`
      UPDATE discord_sessions
      SET last_activity = NOW(), updated_at = NOW()
      WHERE thread_id = ${threadId}
    `;
  }

  async markHealthOk(threadId: string): Promise<void> {
    await this.sql`
      UPDATE discord_sessions
      SET last_health_ok_at = NOW(), updated_at = NOW()
      WHERE thread_id = ${threadId}
    `;
  }

  async updateStatus(threadId: string, status: SessionStatus, lastError?: string | null): Promise<void> {
    await this.sql`
      UPDATE discord_sessions
      SET
        status = ${status},
        last_error = ${lastError ?? null},
        pause_requested_at = CASE WHEN ${status} = 'pausing' THEN NOW() ELSE pause_requested_at END,
        paused_at = CASE WHEN ${status} = 'paused' THEN NOW() ELSE paused_at END,
        resume_attempted_at = CASE WHEN ${status} = 'resuming' THEN NOW() ELSE resume_attempted_at END,
        resumed_at = CASE WHEN ${status} = 'active' THEN NOW() ELSE resumed_at END,
        destroyed_at = CASE WHEN ${status} = 'destroyed' THEN NOW() ELSE destroyed_at END,
        updated_at = NOW()
      WHERE thread_id = ${threadId}
    `;
  }

  async incrementResumeFailure(threadId: string, lastError: string): Promise<void> {
    await this.sql`
      UPDATE discord_sessions
      SET
        resume_fail_count = resume_fail_count + 1,
        last_error = ${lastError},
        updated_at = NOW()
      WHERE thread_id = ${threadId}
    `;
  }

  async listActive(): Promise<SessionInfo[]> {
    const rows = await this.sql`
      SELECT
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        resume_fail_count
      FROM discord_sessions
      WHERE status = 'active'
      ORDER BY last_activity DESC
    ` as SessionRow[];

    return rows.map(toSessionInfo);
  }

  async listStaleActive(cutoffMinutes: number): Promise<SessionInfo[]> {
    const rows = await this.sql`
      SELECT
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        resume_fail_count
      FROM discord_sessions
      WHERE status = 'active'
        AND last_activity < NOW() - (${cutoffMinutes} || ' minutes')::interval
      ORDER BY last_activity ASC
    ` as SessionRow[];

    return rows.map(toSessionInfo);
  }

  async listExpiredPaused(pausedTtlMinutes: number): Promise<SessionInfo[]> {
    const rows = await this.sql`
      SELECT
        thread_id,
        channel_id,
        guild_id,
        sandbox_id,
        session_id,
        preview_url,
        preview_token,
        status,
        last_error,
        resume_fail_count
      FROM discord_sessions
      WHERE status = 'paused'
        AND paused_at IS NOT NULL
        AND paused_at < NOW() - (${pausedTtlMinutes} || ' minutes')::interval
      ORDER BY paused_at ASC
    ` as SessionRow[];

    return rows.map(toSessionInfo);
  }
}

function toSessionInfo(row: SessionRow): SessionInfo {
  return {
    threadId: row.thread_id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    sandboxId: row.sandbox_id,
    sessionId: row.session_id,
    previewUrl: row.preview_url,
    previewToken: row.preview_token,
    status: row.status,
    lastError: row.last_error,
    resumeFailCount: row.resume_fail_count,
  };
}

const sessionStore: SessionStore = new NeonSessionStore();

export function getSessionStore(): SessionStore {
  return sessionStore;
}
