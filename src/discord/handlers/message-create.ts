import type { Client, Message, TextChannel, ThreadChannel, GuildMember } from "discord.js";
import { ChannelType } from "discord.js";
import { getEnv } from "../../config";
import { cleanResponse, splitForDiscord } from "../format";
import { shouldRespondToOwnedThreadTurn } from "../turn-routing";
import { generateThreadName } from "../thread-name";
import type { SandboxManager } from "../../sandbox/manager";
import { logger } from "../../observability/logger";

/**
 * Checks if a channel (or its parent for threads) is allowed.
 * Allowed means: in the ALLOWED_CHANNEL_IDS list, OR in the DISCORD_CATEGORY_ID category.
 */
function isChannelAllowed(channelId: string, categoryId: string | null, env: ReturnType<typeof getEnv>): boolean {
  if (env.ALLOWED_CHANNEL_IDS.length > 0 && env.ALLOWED_CHANNEL_IDS.includes(channelId)) {
    return true;
  }
  if (env.DISCORD_CATEGORY_ID && categoryId === env.DISCORD_CATEGORY_ID) {
    return true;
  }
  return false;
}

/**
 * Checks if a user has the required role (if configured).
 */
function hasRequiredRole(member: GuildMember | null, env: ReturnType<typeof getEnv>): boolean {
  if (!env.DISCORD_REQUIRED_ROLE_ID) return true; // no role requirement
  if (!member) return false;
  return member.roles.cache.has(env.DISCORD_REQUIRED_ROLE_ID);
}

const HISTORY_FETCH_LIMIT = 40;
const HISTORY_LINE_CHAR_LIMIT = 500;
const HISTORY_TOTAL_CHAR_LIMIT = 6000;

function normalizeHistoryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function buildHistoryReplayPrompt(
  thread: ThreadChannel,
  currentMessage: Message,
  latestUserContent: string,
): Promise<{ prompt: string; historyCount: number }> {
  try {
    const fetched = await thread.messages.fetch({ limit: HISTORY_FETCH_LIMIT });
    const ordered = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const lines: string[] = [];
    for (const prior of ordered) {
      if (prior.id === currentMessage.id || prior.system) continue;

      let lineContent = normalizeHistoryText(prior.content);
      if (!lineContent && prior.attachments.size > 0) {
        const files = [...prior.attachments.values()].map((att) => att.name ?? "file").join(", ");
        lineContent = `[attachments: ${files}]`;
      }

      if (!lineContent) continue;
      if (lineContent.length > HISTORY_LINE_CHAR_LIMIT) {
        lineContent = `${lineContent.slice(0, HISTORY_LINE_CHAR_LIMIT)}...`;
      }

      const role = prior.author.bot ? "assistant" : "user";
      lines.push(`${role}: ${lineContent}`);
    }

    if (lines.length === 0) {
      return { prompt: latestUserContent, historyCount: 0 };
    }

    const selected: string[] = [];
    let totalChars = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const candidate = lines[i];
      if (totalChars + candidate.length > HISTORY_TOTAL_CHAR_LIMIT && selected.length > 0) break;
      selected.unshift(candidate);
      totalChars += candidate.length;
    }

    return {
      prompt: [
        "Conversation history from this same Discord thread (oldest to newest):",
        selected.join("\n"),
        "",
        "Continue the same conversation and respond to the latest user message:",
        latestUserContent,
      ].join("\n"),
      historyCount: selected.length,
    };
  } catch {
    return { prompt: latestUserContent, historyCount: 0 };
  }
}

/**
 * Creates a messageCreate event handler bound to the given SandboxManager.
 */
export function createMessageHandler(client: Client, sandboxManager: SandboxManager) {
  const env = getEnv();

  return async (message: Message): Promise<void> => {
    if (message.author.bot) return;

    // Check if the bot is mentioned (ignore @everyone and @here)
    if (message.mentions.everyone) return;

    const botUserId = client.user?.id ?? "";
    const roleId = env.DISCORD_ROLE_ID;

    const mentionedByUser = client.user ? message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: false }) : false;
    const mentionedByRole = roleId ? message.mentions.roles.has(roleId) : false;
    const mentionedInContent = message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`);
    const roleMentionInContent = roleId ? message.content.includes(`<@&${roleId}>`) : false;

    const isMentioned = mentionedByUser || mentionedByRole || mentionedInContent || roleMentionInContent;

    // In threads the bot owns, respond to ALL messages (no mention needed)
    const isInThread = message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread;
    let isOwnedThread = false;
    if (isInThread && !isMentioned) {
      isOwnedThread = await sandboxManager.hasTrackedThread(message.channelId);

      if (isOwnedThread) {
        const decision = await shouldRespondToOwnedThreadTurn({
          mode: env.TURN_ROUTING_MODE,
          model: env.TURN_ROUTING_MODEL,
          apiKey: env.OPENCODE_ZEN_API_KEY,
          content: message.content,
          botUserId,
          botRoleId: roleId,
          mentionedUserIds: [...message.mentions.users.keys()],
          mentionedRoleIds: [...message.mentions.roles.keys()],
        });

        if (!decision.shouldRespond) {
          logger.info({
            event: "discord.message.skipped.not_directed",
            component: "message-handler",
            message: "Skipped turn not directed at bot",
            channelId: message.channelId,
            userId: message.author.id,
            reason: decision.reason,
          });
          return;
        }
      }
    }

    if (!isMentioned && !isOwnedThread) return;

    // Check required role
    const member = message.member;
    if (!hasRequiredRole(member, env)) {
      logger.info({
        event: "discord.message.ignored.role",
        component: "message-handler",
        message: "Ignored message from user without required role",
        channelId: message.channelId,
        userId: message.author.id,
      });
      return;
    }

    logger.info({
      event: "discord.message.triggered",
      component: "message-handler",
      message: "Bot triggered",
      channelId: message.channelId,
      userId: message.author.id,
      isMentioned,
      isOwnedThread,
      contentLength: message.content.length,
    });

    // Strip mentions from content
    const content = message.content.replace(/<@[!&]?\d+>/g, "").trim();
    if (!content) {
      await message.reply("Tag me with a question!").catch(() => {});
      return;
    }

    let thread: ThreadChannel;
    let parentChannelId: string;
    let parentCategoryId: string | null = null;

    try {
      if (isInThread) {
        thread = message.channel as ThreadChannel;
        parentChannelId = thread.parentId ?? "";
        // Get the category from the parent channel
        const parentChannel = thread.parent;
        parentCategoryId = parentChannel?.parentId ?? null;
      } else {
        parentChannelId = message.channelId;
        parentCategoryId = (message.channel as TextChannel).parentId ?? null;

        if (!isChannelAllowed(parentChannelId, parentCategoryId, env)) {
          return;
        }

        const threadName = await generateThreadName(content);
        thread = await (message.channel as TextChannel).threads.create({
          name: threadName,
          startMessage: message,
          autoArchiveDuration: 60,
        });
      }

      // Check allowed for threads too
      if (!isOwnedThread && !isChannelAllowed(parentChannelId, parentCategoryId, env)) {
        return;
      }

      const threadId = thread.id;
      const channelId = parentChannelId;
      const guildId = message.guildId ?? "";

      const trackedBeforeResolve = await sandboxManager.getTrackedSession(threadId);

      // Typing indicator
      let typingActive = true;
      const sendTyping = () => {
        if (typingActive) thread.sendTyping().catch(() => {});
      };
      sendTyping();
      const typingInterval = setInterval(sendTyping, 8000);

      try {
        let session = await sandboxManager.resolveSessionForMessage(threadId, channelId, guildId);
        let historyPromptCache: { prompt: string; historyCount: number } | null = null;

        const getHistoryPrompt = async (): Promise<{ prompt: string; historyCount: number }> => {
          if (!historyPromptCache) {
            historyPromptCache = await buildHistoryReplayPrompt(thread, message, content);
          }
          return historyPromptCache;
        };

        let promptForAgent = content;
        if (trackedBeforeResolve && trackedBeforeResolve.sessionId !== session.sessionId) {
          const replay = await getHistoryPrompt();
          promptForAgent = replay.prompt;
          logger.info({
            event: "discord.context.replayed",
            component: "message-handler",
            message: "Replayed thread history into replacement session",
            threadId,
            previousSessionId: trackedBeforeResolve.sessionId,
            sessionId: session.sessionId,
            historyMessages: replay.historyCount,
          });
        }

        let response: string;
        try {
          response = await sandboxManager.sendMessage(session, promptForAgent);
        } catch (err: any) {
          if (err?.recoverable && err?.message === "SANDBOX_DEAD") {
            logger.warn({
              event: "discord.message.recovering",
              component: "message-handler",
              message: "Recovering by resolving session again",
              threadId,
            });
            await thread.send("*Session changed state, recovering...*").catch(() => {});
            const sessionBeforeRecovery = session.sessionId;
            session = await sandboxManager.resolveSessionForMessage(threadId, channelId, guildId);
            let recoveryPrompt = content;
            if (sessionBeforeRecovery !== session.sessionId) {
              const replay = await getHistoryPrompt();
              recoveryPrompt = replay.prompt;
              logger.info({
                event: "discord.context.replayed",
                component: "message-handler",
                message: "Replayed thread history after recovery",
                threadId,
                previousSessionId: sessionBeforeRecovery,
                sessionId: session.sessionId,
                historyMessages: replay.historyCount,
              });
            }
            response = await sandboxManager.sendMessage(session, recoveryPrompt);
          } else {
            throw err;
          }
        }

        const cleaned = cleanResponse(response);
        const chunks = splitForDiscord(cleaned);

        for (const chunk of chunks) {
          await thread.send(chunk);
        }
      } catch (err) {
        logger.error({
          event: "discord.message.failed",
          component: "message-handler",
          message: "Error handling message",
          threadId,
          error: err,
        });
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        await thread.send(`Something went wrong: ${errorMsg}`).catch(() => {});
      } finally {
        typingActive = false;
        clearInterval(typingInterval);
      }
    } catch (err) {
      logger.error({
        event: "discord.message.setup_failed",
        component: "message-handler",
        message: "Error processing message",
        channelId: message.channelId,
        error: err,
      });
      await message.reply("Something went wrong setting up the thread.").catch(() => {});
    }
  };
}
