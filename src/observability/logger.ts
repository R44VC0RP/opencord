import { getEnv } from "../config";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = {
  event: string;
  message: string;
  component?: string;
  threadId?: string;
  channelId?: string;
  guildId?: string;
  sandboxId?: string;
  sessionId?: string;
  durationMs?: number;
  [key: string]: unknown;
};

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(level: LogLevel): boolean {
  const env = getEnv();
  return levelOrder[level] >= levelOrder[env.LOG_LEVEL];
}

function serializeError(err: unknown) {
  if (!(err instanceof Error)) return err;
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
}

function write(level: LogLevel, fields: LogFields): void {
  if (!shouldLog(level)) return;

  const env = getEnv();
  const payload = {
    ts: new Date().toISOString(),
    level,
    ...fields,
  };

  if (env.LOG_PRETTY) {
    const line = `[${payload.ts}] ${level.toUpperCase()} ${fields.event} ${fields.message}`;
    console.log(line, JSON.stringify(payload));
    return;
  }

  console.log(JSON.stringify(payload));
}

export const logger = {
  debug(fields: LogFields) {
    write("debug", fields);
  },
  info(fields: LogFields) {
    write("info", fields);
  },
  warn(fields: LogFields) {
    write("warn", fields);
  },
  error(fields: LogFields & { error?: unknown }) {
    write("error", {
      ...fields,
      error: fields.error ? serializeError(fields.error) : undefined,
    });
  },
};

export type { LogFields, LogLevel };
