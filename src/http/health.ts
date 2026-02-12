import type { Client } from "discord.js";

type HealthDependencies = {
  client: Client;
  isCleanupLoopRunning: () => boolean;
  getActiveSessionCount: () => Promise<number>;
};

export function startHealthServer(host: string, port: number, deps: HealthDependencies): Bun.Server<unknown> {
  const startedAt = Date.now();

  return Bun.serve({
    hostname: host,
    port,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") {
        const activeSessions = await deps.getActiveSessionCount().catch(() => 0);
        return Response.json({
          ok: true,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          discordReady: deps.client.isReady(),
          cleanupLoopRunning: deps.isCleanupLoopRunning(),
          activeSessions,
        });
      }

      if (url.pathname === "/readyz") {
        const ready = deps.client.isReady();
        return Response.json(
          {
            ok: ready,
            discordReady: ready,
          },
          { status: ready ? 200 : 503 },
        );
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}
