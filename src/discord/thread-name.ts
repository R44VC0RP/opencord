import { getEnv } from "../config";

const ZEN_MESSAGES_URL = "https://opencode.ai/zen/v1/messages";

/**
 * Uses Claude Haiku 4.5 via OpenCode Zen to generate a concise thread name
 * from the user's message. Falls back to truncation on error.
 */
export async function generateThreadName(userMessage: string): Promise<string> {
  try {
    const env = getEnv();

    const res = await fetch(ZEN_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.OPENCODE_ZEN_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 60,
        messages: [
          {
            role: "user",
            content: `Generate a short, descriptive thread title (max 90 chars) for this Discord question. Return ONLY the title, no quotes, no explanation.\n\nQuestion: ${userMessage}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.warn(`[thread-name] Zen API returned ${res.status}, falling back to truncation`);
      return fallback(userMessage);
    }

    const data = await res.json() as {
      content?: Array<{ type: string; text?: string }>;
    };

    const title = data.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();

    if (!title || title.length === 0) return fallback(userMessage);

    // Ensure it fits Discord's thread name limit (100 chars)
    return title.slice(0, 95) + (title.length > 95 ? "..." : "");
  } catch (err) {
    console.warn("[thread-name] Failed to generate name:", err);
    return fallback(userMessage);
  }
}

function fallback(message: string): string {
  return message.slice(0, 95) + (message.length > 95 ? "..." : "");
}
