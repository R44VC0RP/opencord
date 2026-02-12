import { Daytona } from "@daytonaio/sdk";
import { readFileSync } from "node:fs";
import { getEnv } from "../config";
import { logger } from "../observability/logger";
import { getSessionStore } from "../sessions/store";
import type { SessionInfo, SessionStatus } from "../types";
import { getDiscordBotImage } from "./image";
import { createSession, listSessions, sendPrompt, sessionExists, waitForHealthy } from "./opencode-client";

/** In-memory timeout handles keyed by threadId */
const timeouts = new Map<string, ReturnType<typeof setTimeout>>();

type ResumeAttemptResult = {
  session: SessionInfo | null;
  allowRecreate: boolean;
};

function timer() {
  const start = Date.now();
  return {
    elapsedMs: () => Date.now() - start,
  };
}

function createDaytona() {
  return new Daytona({
    apiKey: getEnv().DAYTONA_API_KEY,
    _experimental: {},
  });
}

function isSandboxMissingError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("not found") || message.includes("does not exist") || message.includes("destroyed");
}

async function exec(
  sandbox: {
    process: {
      executeCommand: (
        cmd: string,
        cwd?: string,
        env?: Record<string, string>,
        timeout?: number,
      ) => Promise<{ exitCode: number; result: string }>;
    };
  },
  label: string,
  command: string,
  context: Pick<SessionInfo, "threadId" | "sandboxId">,
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<string> {
  const t = timer();
  const result = await sandbox.process.executeCommand(command, options?.cwd, options?.env);

  if (result.exitCode !== 0) {
    logger.error({
      event: "sandbox.exec.failed",
      component: "sandbox-manager",
      message: "Sandbox command failed",
      threadId: context.threadId,
      sandboxId: context.sandboxId,
      label,
      exitCode: result.exitCode,
      durationMs: t.elapsedMs(),
      stdout: result.result.slice(0, 500),
    });
    throw new Error(`${label} failed (exit ${result.exitCode})`);
  }

  logger.debug({
    event: "sandbox.exec.ok",
    component: "sandbox-manager",
    message: "Sandbox command completed",
    threadId: context.threadId,
    sandboxId: context.sandboxId,
    label,
    durationMs: t.elapsedMs(),
  });

  return result.result.trim();
}

export class SandboxManager {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly store = getSessionStore();
  private readonly threadLocks = new Map<string, Promise<void>>();

  async getActiveSessionCount(): Promise<number> {
    return (await this.store.listActive()).length;
  }

  isCleanupLoopRunning(): boolean {
    return this.cleanupInterval !== null;
  }

  async hasTrackedThread(threadId: string): Promise<boolean> {
    return this.store.hasTrackedThread(threadId);
  }

  async getTrackedSession(threadId: string): Promise<SessionInfo | null> {
    return this.store.getByThread(threadId);
  }

  async getSession(threadId: string): Promise<SessionInfo | null> {
    return this.store.getActive(threadId);
  }

  async resolveSessionForMessage(threadId: string, channelId: string, guildId: string): Promise<SessionInfo> {
    return this.withThreadLock(threadId, async () => {
      const existing = await this.store.getByThread(threadId);
      const env = getEnv();

      if (!existing) {
        return this.createSessionUnlocked(threadId, channelId, guildId);
      }

      let candidate = existing;

      if (candidate.status === "active") {
        const healthy = await this.ensureSessionHealthy(candidate, 15_000);
        if (healthy) return candidate;
        candidate = (await this.store.getByThread(threadId)) ?? { ...candidate, status: "error" };
      }

      if (env.SANDBOX_REUSE_POLICY === "resume_preferred") {
        const resumed = await this.tryResumeSession(candidate);
        if (resumed.session) return resumed.session;

        if (!resumed.allowRecreate) {
          throw new Error("Unable to reattach to existing sandbox session. Try again shortly.");
        }
      }

      return this.createSessionUnlocked(threadId, channelId, guildId);
    });
  }

  async createSession(threadId: string, channelId: string, guildId: string): Promise<SessionInfo> {
    return this.withThreadLock(threadId, async () => this.createSessionUnlocked(threadId, channelId, guildId));
  }

  private async createSessionUnlocked(threadId: string, channelId: string, guildId: string): Promise<SessionInfo> {
    const env = getEnv();
    const totalTimer = timer();

    await this.store.updateStatus(threadId, "creating").catch(() => {});

    const daytona = createDaytona();
    const image = getDiscordBotImage();
    const sandbox = await daytona.create(
      {
        image,
        labels: {
          app: "opencord",
          threadId,
          guildId,
        },
        autoStopInterval: 0,
        autoArchiveInterval: 0,
      },
      { timeout: env.SANDBOX_CREATION_TIMEOUT },
    );

    const sandboxId = sandbox.id;
    logger.info({
      event: "sandbox.create.started",
      component: "sandbox-manager",
      message: "Created sandbox",
      threadId,
      channelId,
      guildId,
      sandboxId,
    });

    try {
      const context = { threadId, sandboxId };
      const home = await exec(sandbox, "discover-home", "echo $HOME", context);

      await exec(
        sandbox,
        "clone-opencode",
        `git clone --depth=1 https://github.com/anomalyco/opencode.git ${home}/opencode`,
        context,
      );

      const authJson = JSON.stringify({
        opencode: { type: "api", key: env.OPENCODE_ZEN_API_KEY },
      });

      await exec(
        sandbox,
        "write-auth",
        `mkdir -p ${home}/.local/share/opencode && cat > ${home}/.local/share/opencode/auth.json << 'AUTHEOF'\n${authJson}\nAUTHEOF`,
        context,
      );

      const agentPromptPath = new URL("../agent-prompt.md", import.meta.url);
      const agentPrompt = readFileSync(agentPromptPath, "utf-8");

      const opencodeConfig = JSON.stringify({
        model: env.OPENCODE_MODEL,
        share: "disabled",
        permission: "allow",
        agent: {
          build: {
            mode: "primary",
            prompt: agentPrompt,
          },
        },
      });

      const configB64 = Buffer.from(opencodeConfig).toString("base64");
      await exec(
        sandbox,
        "write-config",
        `echo "${configB64}" | base64 -d > ${home}/opencode/opencode.json`,
        context,
      );

      const opencodeEnv = this.buildRuntimeEnv();
      const githubToken = opencodeEnv.GITHUB_TOKEN ?? "";

      logger.info({
        event: "sandbox.github.auth",
        component: "sandbox-manager",
        message: githubToken.length > 0
          ? "Configured authenticated gh CLI in sandbox runtime"
          : "Running sandbox gh CLI unauthenticated (no GITHUB_TOKEN provided)",
        threadId,
        sandboxId,
        authenticated: githubToken.length > 0,
      });

      await exec(
        sandbox,
        "start-opencode",
        "setsid opencode serve --port 4096 --hostname 0.0.0.0 > /tmp/opencode.log 2>&1 &",
        context,
        {
          cwd: `${home}/opencode`,
          env: opencodeEnv,
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const preview = await sandbox.getPreviewLink(4096);
      const previewUrl = preview.url.replace(/\/$/, "");
      const previewToken = preview.token ?? null;

      const healthy = await waitForHealthy({ previewUrl, previewToken }, 120_000);
      if (!healthy) {
        const startupLog = await exec(sandbox, "read-opencode-log", "cat /tmp/opencode.log 2>/dev/null | tail -100", context);
        throw new Error(`OpenCode server did not become healthy: ${startupLog.slice(0, 400)}`);
      }

      const sessionId = await createSession({ previewUrl, previewToken }, `Discord thread ${threadId}`);

      const session: SessionInfo = {
        threadId,
        channelId,
        guildId,
        sandboxId,
        sessionId,
        previewUrl,
        previewToken,
        status: "active",
      };

      await this.store.upsert(session);
      await this.store.markHealthOk(threadId);
      this.resetTimeout(threadId);

      logger.info({
        event: "sandbox.create.ready",
        component: "sandbox-manager",
        message: "Session is ready",
        threadId,
        channelId,
        guildId,
        sandboxId,
        sessionId,
        durationMs: totalTimer.elapsedMs(),
      });

      return session;
    } catch (error) {
      logger.error({
        event: "sandbox.create.failed",
        component: "sandbox-manager",
        message: "Failed to create session",
        threadId,
        channelId,
        guildId,
        sandboxId,
        durationMs: totalTimer.elapsedMs(),
        error,
      });

      await this.store.updateStatus(threadId, "error", error instanceof Error ? error.message : String(error)).catch(() => {});
      await daytona.delete(sandbox).catch(() => {});
      throw error;
    }
  }

  async sendMessage(session: SessionInfo, text: string): Promise<string> {
    return this.withThreadLock(session.threadId, async () => {
      const t = timer();
      await this.store.markActivity(session.threadId);
      this.resetTimeout(session.threadId);

      try {
        const response = await sendPrompt(
          { previewUrl: session.previewUrl, previewToken: session.previewToken },
          session.sessionId,
          text,
        );

        logger.info({
          event: "session.message.ok",
          component: "sandbox-manager",
          message: "Message processed",
          threadId: session.threadId,
          sandboxId: session.sandboxId,
          sessionId: session.sessionId,
          durationMs: t.elapsedMs(),
          responseChars: response.length,
        });

        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const sessionMissing = message.includes("Failed to send prompt (404");
        const recoverable =
          message.includes("no IP address found") ||
          message.includes("Is the Sandbox started") ||
          message.includes("sandbox not found") ||
          message.includes("Failed to send prompt (5") ||
          sessionMissing;

        if (recoverable) {
          await this.store.incrementResumeFailure(session.threadId, message);
          if (sessionMissing) {
            await this.store.updateStatus(session.threadId, "error", "opencode-session-missing").catch(() => {});
          } else {
            await this.pauseSessionUnlocked(session.threadId, "recoverable send failure").catch(() => {});
          }
          const recoveryError = new Error("SANDBOX_DEAD");
          (recoveryError as any).recoverable = true;
          throw recoveryError;
        }

        throw error;
      }
    });
  }

  async pauseSession(threadId: string, reason = "manual"): Promise<void> {
    await this.withThreadLock(threadId, async () => {
      await this.pauseSessionUnlocked(threadId, reason);
    });
  }

  private async pauseSessionUnlocked(threadId: string, reason: string): Promise<void> {
    const session = await this.store.getByThread(threadId);
    if (!session) return;
    if (session.status === "paused") return;

    await this.store.updateStatus(threadId, "pausing", reason);

    try {
      const daytona = createDaytona();
      const sandbox = await daytona.get(session.sandboxId);
      await daytona.stop(sandbox);
      await this.store.updateStatus(threadId, "paused", null);
      this.clearTimeout(threadId);

      logger.info({
        event: "sandbox.paused",
        component: "sandbox-manager",
        message: "Paused sandbox",
        threadId,
        sandboxId: session.sandboxId,
        reason,
      });
    } catch (error) {
      await this.store.updateStatus(threadId, "destroyed", error instanceof Error ? error.message : String(error));
      logger.warn({
        event: "sandbox.pause.missing",
        component: "sandbox-manager",
        message: "Sandbox unavailable while pausing; marked destroyed",
        threadId,
        sandboxId: session.sandboxId,
      });
    }
  }

  private async tryResumeSession(session: SessionInfo): Promise<ResumeAttemptResult> {
    if (!["paused", "destroyed", "error", "pausing", "resuming"].includes(session.status)) {
      return { session: null, allowRecreate: true };
    }

    await this.store.updateStatus(session.threadId, "resuming");

    const daytona = createDaytona();
    let sandbox: Awaited<ReturnType<typeof daytona.get>>;

    try {
      sandbox = await daytona.get(session.sandboxId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.store.incrementResumeFailure(session.threadId, errorMessage).catch(() => {});
      await this.store.updateStatus(session.threadId, "destroyed", errorMessage).catch(() => {});

      logger.warn({
        event: "sandbox.resume.sandbox_missing",
        component: "sandbox-manager",
        message: "Sandbox missing during resume; safe to recreate",
        threadId: session.threadId,
        sandboxId: session.sandboxId,
        errorMessage,
      });

      return { session: null, allowRecreate: true };
    }

    try {
      await daytona.start(sandbox, getEnv().SANDBOX_CREATION_TIMEOUT);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.store.incrementResumeFailure(session.threadId, errorMessage).catch(() => {});
      await this.store.updateStatus(session.threadId, "error", errorMessage).catch(() => {});

      const allowRecreate = isSandboxMissingError(error);
      logger.warn({
        event: "sandbox.resume.start_failed",
        component: "sandbox-manager",
        message: allowRecreate
          ? "Sandbox no longer exists while starting; safe to recreate"
          : "Sandbox start failed; refusing automatic recreate to avoid context loss",
        threadId: session.threadId,
        sandboxId: session.sandboxId,
        errorMessage,
        allowRecreate,
      });

      return { session: null, allowRecreate };
    }

    try {
      const preview = await sandbox.getPreviewLink(4096);
      const previewUrl = preview.url.replace(/\/$/, "");
      const previewToken = preview.token ?? null;

      const context = { threadId: session.threadId, sandboxId: session.sandboxId };

      logger.info({
        event: "sandbox.resume.restarting_opencode",
        component: "sandbox-manager",
        message: "Restarting opencode serve after sandbox start",
        threadId: session.threadId,
        sandboxId: session.sandboxId,
      });

      await exec(
        sandbox,
        "restart-opencode-serve",
        "pkill -f 'opencode serve --port 4096' >/dev/null 2>&1 || true; for d in \"$HOME/opencode\" \"/home/daytona/opencode\" \"/root/opencode\"; do if [ -d \"$d\" ]; then cd \"$d\" && setsid opencode serve --port 4096 --hostname 0.0.0.0 > /tmp/opencode.log 2>&1 & exit 0; fi; done; exit 1",
        context,
        { env: this.buildRuntimeEnv() },
      );

      const healthy = await waitForHealthy(
        { previewUrl, previewToken },
        getEnv().RESUME_HEALTH_TIMEOUT_MS,
      );

      if (!healthy) {
        const startupLog = await exec(
          sandbox,
          "read-opencode-log-after-resume",
          "cat /tmp/opencode.log 2>/dev/null | tail -120",
          context,
        ).catch(() => "(unable to read opencode log)");

        const errorMessage = `OpenCode health check failed after resume. Log: ${startupLog.slice(0, 500)}`;
        await this.store.incrementResumeFailure(session.threadId, errorMessage).catch(() => {});
        await this.store.updateStatus(session.threadId, "error", errorMessage).catch(() => {});

        logger.error({
          event: "sandbox.resume.health_failed",
          component: "sandbox-manager",
          message: "OpenCode did not become healthy after restart; refusing recreate",
          threadId: session.threadId,
          sandboxId: session.sandboxId,
          errorMessage,
        });

        return { session: null, allowRecreate: false };
      }

      let sessionId = session.sessionId;
      const existingSession = await sessionExists({ previewUrl, previewToken }, sessionId);
      if (!existingSession) {
        const expectedTitle = `Discord thread ${session.threadId}`;
        const sessions = await listSessions({ previewUrl, previewToken }, 50).catch(() => []);

        const replacement = sessions
          .filter((candidate) => candidate.title === expectedTitle)
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];

        if (replacement) {
          sessionId = replacement.id;
          logger.info({
            event: "sandbox.resume.session_reused_by_title",
            component: "sandbox-manager",
            message: "Reattached to existing session by title",
            threadId: session.threadId,
            sandboxId: session.sandboxId,
            previousSessionId: session.sessionId,
            sessionId,
          });
        } else {
          logger.warn({
            event: "sandbox.resume.session_missing",
            component: "sandbox-manager",
            message: "OpenCode session missing after resume; creating replacement session",
            threadId: session.threadId,
            sandboxId: session.sandboxId,
            sessionId,
          });

          sessionId = await createSession({ previewUrl, previewToken }, expectedTitle);
        }
      }

      const resumed: SessionInfo = {
        ...session,
        sessionId,
        previewUrl,
        previewToken,
        status: "active",
      };

      await this.store.upsert(resumed);
      await this.store.markHealthOk(session.threadId);
      this.resetTimeout(session.threadId);

      logger.info({
        event: "sandbox.resumed",
        component: "sandbox-manager",
        message: "Resumed existing sandbox",
        threadId: session.threadId,
        sandboxId: session.sandboxId,
        previousSessionId: session.sessionId,
        sessionId,
        sessionReattached: sessionId === session.sessionId,
      });

      return { session: resumed, allowRecreate: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.store.incrementResumeFailure(session.threadId, errorMessage).catch(() => {});
      await this.store.updateStatus(session.threadId, "error", errorMessage).catch(() => {});

      logger.warn({
        event: "sandbox.resume.failed",
        component: "sandbox-manager",
        message: "Resume failed after sandbox start; refusing automatic recreate",
        threadId: session.threadId,
        sandboxId: session.sandboxId,
        errorMessage,
      });

      return { session: null, allowRecreate: false };
    }
  }

  async destroySession(threadId: string): Promise<void> {
    await this.withThreadLock(threadId, async () => {
      const session = await this.store.getByThread(threadId);
      if (!session) return;

      await this.store.updateStatus(threadId, "destroying");

      try {
        const daytona = createDaytona();
        const sandbox = await daytona.get(session.sandboxId);
        await daytona.delete(sandbox);
      } catch {
        // no-op
      }

      await this.store.updateStatus(threadId, "destroyed");
      this.clearTimeout(threadId);
    });
  }

  resetTimeout(threadId: string): void {
    this.clearTimeout(threadId);
    const timeoutMs = getEnv().SANDBOX_TIMEOUT_MINUTES * 60 * 1000;

    const handle = setTimeout(async () => {
      timeouts.delete(threadId);
      await this.pauseSession(threadId, "inactivity-timeout").catch((error) => {
        logger.error({
          event: "sandbox.pause.timeout.failed",
          component: "sandbox-manager",
          message: "Failed to pause sandbox on inactivity timeout",
          threadId,
          error,
        });
      });
    }, timeoutMs);

    timeouts.set(threadId, handle);
  }

  private clearTimeout(threadId: string): void {
    const existing = timeouts.get(threadId);
    if (!existing) return;
    clearTimeout(existing);
    timeouts.delete(threadId);
  }

  startCleanupLoop(): void {
    const intervalMs = 5 * 60 * 1000;

    this.cleanupInterval = setInterval(async () => {
      try {
        const env = getEnv();
        const staleActive = await this.store.listStaleActive(env.SANDBOX_TIMEOUT_MINUTES + 5);

        for (const session of staleActive) {
          await this.pauseSession(session.threadId, "cleanup-stale-active");
        }

        const expiredPaused = await this.store.listExpiredPaused(env.PAUSED_TTL_MINUTES);
        for (const session of expiredPaused) {
          await this.destroySession(session.threadId);
        }
      } catch (error) {
        logger.error({
          event: "cleanup.loop.failed",
          component: "sandbox-manager",
          message: "Cleanup loop failed",
          error,
        });
      }
    }, intervalMs);

    logger.info({
      event: "cleanup.loop.started",
      component: "sandbox-manager",
      message: "Started cleanup loop",
      intervalMs,
      timeoutMinutes: getEnv().SANDBOX_TIMEOUT_MINUTES,
      pausedTtlMinutes: getEnv().PAUSED_TTL_MINUTES,
    });
  }

  stopCleanupLoop(): void {
    if (!this.cleanupInterval) return;
    clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
  }

  async destroyAll(): Promise<void> {
    const active = await this.store.listActive();
    await Promise.allSettled(active.map((session) => this.pauseSession(session.threadId, "shutdown")));
  }

  private buildRuntimeEnv(): Record<string, string> {
    const env = getEnv();
    const runtimeEnv: Record<string, string> = {};
    const githubToken = env.GITHUB_TOKEN.trim();

    if (githubToken.length > 0) {
      runtimeEnv.GH_TOKEN = githubToken;
      runtimeEnv.GITHUB_TOKEN = githubToken;
    }

    return runtimeEnv;
  }

  private async ensureSessionHealthy(session: SessionInfo, maxWaitMs: number): Promise<boolean> {
    const healthy = await waitForHealthy(
      { previewUrl: session.previewUrl, previewToken: session.previewToken },
      maxWaitMs,
    );

    if (!healthy) {
      await this.store.incrementResumeFailure(session.threadId, "active-session-healthcheck-failed").catch(() => {});
      await this.store.updateStatus(session.threadId, "error", "active-session-healthcheck-failed").catch(() => {});
      return false;
    }

    const attached = await sessionExists(
      { previewUrl: session.previewUrl, previewToken: session.previewToken },
      session.sessionId,
    ).catch(() => false);

    if (!attached) {
      await this.store.incrementResumeFailure(session.threadId, "active-session-missing").catch(() => {});
      await this.store.updateStatus(session.threadId, "error", "active-session-missing").catch(() => {});
      return false;
    }

    await this.store.markHealthOk(session.threadId).catch(() => {});
    return true;
  }

  private async withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.threadLocks.set(threadId, previous.then(() => current));
    await previous;

    try {
      return await fn();
    } finally {
      release();
      if (this.threadLocks.get(threadId) === current) {
        this.threadLocks.delete(threadId);
      }
    }
  }
}

export type { SessionStatus };
