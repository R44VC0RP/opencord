import { Effect, Schedule } from "effect";
import { logger } from "../observability/logger";

type PreviewAccess = {
  previewUrl: string;
  previewToken?: string | null;
};

export type OpenCodeSessionSummary = {
  id: string;
  title: string;
  updatedAt?: number;
};

/**
 * Parse a Daytona preview URL into base URL and token.
 * Preview URLs look like: https://4096-xxx.proxy.daytona.works?tkn=abc123
 */
function parsePreview(input: string | PreviewAccess): { base: string; token: string | null } {
  const previewUrl = typeof input === "string" ? input : input.previewUrl;
  const url = new URL(previewUrl);
  const token = typeof input === "string"
    ? url.searchParams.get("tkn")
    : (input.previewToken ?? url.searchParams.get("tkn"));
  url.searchParams.delete("tkn");
  return { base: url.toString().replace(/\/$/, ""), token };
}

/**
 * Fetch wrapper that properly handles Daytona preview URL token auth.
 * Sends token as x-daytona-preview-token header.
 */
async function previewFetch(preview: string | PreviewAccess, path: string, init?: RequestInit): Promise<Response> {
  const { base, token } = parsePreview(preview);
  const url = `${base}${path}`;
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("x-daytona-preview-token", token);
  }
  return fetch(url, { ...init, headers });
}

/**
 * Waits for the OpenCode server inside a sandbox to become healthy.
 * Polls GET /global/health every 2s up to maxWaitMs.
 */
export async function waitForHealthy(preview: string | PreviewAccess, maxWaitMs = 120_000): Promise<boolean> {
  const start = Date.now();
  let lastStatus = "";

  const poll = Effect.tryPromise(async () => {
    const res = await previewFetch(preview, "/global/health");
    lastStatus = `${res.status}`;

    if (res.ok) {
      const body = await res.json() as { healthy?: boolean };
      if (body.healthy) return true;
      lastStatus = `200 but healthy=${body.healthy}`;
      throw new Error(lastStatus);
    }

    const body = await res.text().catch(() => "");
    lastStatus = `${res.status}: ${body.slice(0, 150)}`;
    throw new Error(lastStatus);
  }).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        logger.warn({
          event: "opencode.health.poll",
          component: "opencode-client",
          message: "Health check poll failed",
          elapsedSec: Number(elapsed),
          lastStatus,
        });
      }),
    ),
  );

  const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / 2000));

  return Effect.runPromise(
    poll.pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("2 seconds"),
          Schedule.recurs(maxAttempts - 1),
        ),
      ),
      Effect.as(true),
      Effect.catchAll(() =>
        Effect.sync(() => {
          logger.error({
            event: "opencode.health.failed",
            component: "opencode-client",
            message: "Health check failed",
            maxWaitMs,
            lastStatus,
          });
          return false;
        }),
      ),
    ),
  );
}

/**
 * Creates a new OpenCode session and returns the session ID.
 */
export async function createSession(preview: string | PreviewAccess, title: string): Promise<string> {
  const res = await previewFetch(preview, "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to create session (${res.status}): ${body}`);
  }

  const session = await res.json() as { id: string };
  return session.id;
}

export async function sessionExists(preview: string | PreviewAccess, sessionId: string): Promise<boolean> {
  const res = await previewFetch(preview, `/session/${sessionId}`, {
    method: "GET",
  });

  if (res.ok) return true;
  if (res.status === 404) return false;

  const body = await res.text().catch(() => "");
  throw new Error(`Failed to check session (${res.status}): ${body}`);
}

export async function listSessions(preview: string | PreviewAccess, limit = 50): Promise<OpenCodeSessionSummary[]> {
  const query = limit > 0 ? `?limit=${limit}` : "";
  const res = await previewFetch(preview, `/session${query}`, {
    method: "GET",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to list sessions (${res.status}): ${body}`);
  }

  const sessions = await res.json() as Array<{
    id?: string;
    title?: string;
    time?: { updated?: number };
  }>;

  return sessions
    .filter((session) => typeof session.id === "string")
    .map((session) => ({
      id: session.id as string,
      title: session.title ?? "",
      updatedAt: session.time?.updated,
    }));
}

/**
 * Sends a prompt to an existing session and returns the text response.
 * This call blocks until the agent finishes processing.
 */
export async function sendPrompt(preview: string | PreviewAccess, sessionId: string, text: string): Promise<string> {
  const res = await previewFetch(preview, `/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to send prompt (${res.status}): ${body}`);
  }

  const result = await res.json() as { parts?: Array<{ type: string; text?: string; content?: string }> };
  const parts = result.parts ?? [];

  const textContent = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text || p.content || "")
    .filter(Boolean);

  return textContent.join("\n\n") || "(No response from agent)";
}

/**
 * Aborts a running session.
 */
export async function abortSession(preview: string | PreviewAccess, sessionId: string): Promise<void> {
  await previewFetch(preview, `/session/${sessionId}/abort`, { method: "POST" }).catch(() => {});
}
