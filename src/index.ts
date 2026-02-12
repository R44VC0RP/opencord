import { getEnv } from "./config";
import { createDiscordClient } from "./discord/client";
import { createMessageHandler } from "./discord/handlers/message-create";
import { initializeDatabase } from "./db/init";
import { startHealthServer } from "./http/health";
import { logger } from "./observability/logger";
import { SandboxManager } from "./sandbox/manager";

async function main() {
  const env = getEnv();
  logger.info({ event: "app.starting", component: "index", message: "Starting Discord bot" });
  await initializeDatabase();
  logger.info({ event: "db.ready", component: "index", message: "Database ready" });

  const client = createDiscordClient();
  const sandboxManager = new SandboxManager();
  const healthServer = startHealthServer(env.HEALTH_HOST, env.HEALTH_PORT, {
    client,
    isCleanupLoopRunning: () => sandboxManager.isCleanupLoopRunning(),
    getActiveSessionCount: () => sandboxManager.getActiveSessionCount(),
  });

  logger.info({
    event: "health.server.started",
    component: "index",
    message: "Health server started",
    host: env.HEALTH_HOST,
    port: env.HEALTH_PORT,
  });

  // Register message handler
  const messageHandler = createMessageHandler(client, sandboxManager);
  client.on("messageCreate", messageHandler);

  // Ready event
  client.on("clientReady", () => {
    logger.info({
      event: "discord.ready",
      component: "index",
      message: "Discord client ready",
      tag: client.user?.tag,
      allowedChannels: env.ALLOWED_CHANNEL_IDS,
    });
    sandboxManager.startCleanupLoop();
  });

  // Login
  await client.login(env.DISCORD_TOKEN);

  let shuttingDown = false;

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({
      event: "app.shutdown.start",
      component: "index",
      message: "Shutting down",
      signal,
    });
    healthServer.stop();
    sandboxManager.stopCleanupLoop();
    await sandboxManager.destroyAll();
    client.destroy();
    logger.info({ event: "app.shutdown.complete", component: "index", message: "Shutdown complete" });
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({
    event: "app.fatal",
    component: "index",
    message: "Fatal error",
    error: err,
  });
  process.exit(1);
});
