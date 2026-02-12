export type SessionStatus =
  | "creating"
  | "active"
  | "pausing"
  | "paused"
  | "resuming"
  | "destroying"
  | "destroyed"
  | "error";

export interface SessionInfo {
  threadId: string;
  channelId: string;
  guildId: string;
  sandboxId: string;
  sessionId: string;
  previewUrl: string;
  previewToken: string | null;
  status: SessionStatus;
  lastError?: string | null;
  resumeFailCount?: number;
}
