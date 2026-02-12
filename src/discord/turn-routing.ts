const ZEN_MESSAGES_URL = "https://opencode.ai/zen/v1/messages";

export type TurnRoutingMode = "off" | "heuristic" | "ai";

type TurnRoutingInput = {
  mode: TurnRoutingMode;
  model: string;
  apiKey: string;
  content: string;
  botUserId: string;
  botRoleId: string;
  mentionedUserIds: string[];
  mentionedRoleIds: string[];
};

export type TurnRoutingDecision = {
  shouldRespond: boolean;
  reason: string;
};

const QUICK_CHAT_RE = /^(ok|okay|k|kk|thanks|thank you|thx|lol|lmao|haha|nice|cool|yup|yep|nah|nope|got it|sgtm)[!. ]*$/i;

function heuristicDecision(input: TurnRoutingInput): TurnRoutingDecision | null {
  const text = input.content.trim();
  const lower = text.toLowerCase();

  if (!text) {
    return { shouldRespond: false, reason: "empty-message" };
  }

  const mentionsOtherUser = input.mentionedUserIds.some((id) => id !== input.botUserId);
  if (mentionsOtherUser) {
    return { shouldRespond: false, reason: "mentions-other-user" };
  }

  const mentionsOtherRole = input.mentionedRoleIds.some((id) => id !== input.botRoleId);
  if (mentionsOtherRole) {
    return { shouldRespond: false, reason: "mentions-other-role" };
  }

  if (text.length <= 40 && QUICK_CHAT_RE.test(text)) {
    return { shouldRespond: false, reason: "quick-chat" };
  }

  if (/\b(opencode|bot)\b/i.test(text)) {
    return { shouldRespond: true, reason: "bot-keyword" };
  }

  if (text.includes("?") && /\b(you|your|can you|could you|would you|please|help)\b/i.test(text)) {
    return { shouldRespond: true, reason: "direct-question" };
  }

  if (text.includes("?") && /\b(how|what|why|where|when|which)\b/i.test(text)) {
    return { shouldRespond: true, reason: "general-question" };
  }

  if (lower.startsWith("do this") || lower.startsWith("run ") || lower.startsWith("fix ")) {
    return { shouldRespond: true, reason: "instruction" };
  }

  return null;
}

async function aiDecision(input: TurnRoutingInput): Promise<TurnRoutingDecision> {
  const prompt = [
    "You route turns for an engineering Discord bot.",
    "Decide if the latest message is directed at the bot assistant or is side conversation.",
    "Return EXACTLY one token: RESPOND or SKIP.",
    "",
    `Message: ${input.content}`,
    `MentionsOtherUser: ${input.mentionedUserIds.some((id) => id !== input.botUserId)}`,
    `MentionsOtherRole: ${input.mentionedRoleIds.some((id) => id !== input.botRoleId)}`,
  ].join("\n");

  const res = await fetch(ZEN_MESSAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 10,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    return { shouldRespond: true, reason: `ai-http-${res.status}` };
  }

  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const output = data.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join(" ")
    .trim()
    .toUpperCase();

  if (output?.includes("SKIP")) {
    return { shouldRespond: false, reason: "ai-skip" };
  }

  return { shouldRespond: true, reason: output?.includes("RESPOND") ? "ai-respond" : "ai-default-respond" };
}

export async function shouldRespondToOwnedThreadTurn(input: TurnRoutingInput): Promise<TurnRoutingDecision> {
  if (input.mode === "off") {
    return { shouldRespond: true, reason: "routing-off" };
  }

  const heuristic = heuristicDecision(input);
  if (heuristic) {
    return heuristic;
  }

  if (input.mode === "heuristic") {
    return { shouldRespond: true, reason: "heuristic-uncertain-default-respond" };
  }

  try {
    return await aiDecision(input);
  } catch {
    return { shouldRespond: true, reason: "ai-error-default-respond" };
  }
}
