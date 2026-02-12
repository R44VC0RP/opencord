const MAX_MESSAGE_LENGTH = 1900;

/**
 * Splits a long response into Discord-safe message chunks (<2000 chars).
 * Splits at code block boundaries, paragraph breaks, or sentence ends.
 * Handles unclosed code blocks across chunks.
 */
export function splitForDiscord(text: string): string[] {
  if (!text || text.length === 0) return ["(No response)"];
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const messages: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      messages.push(remaining);
      break;
    }

    // Find best split point
    let splitAt = -1;

    // Prefer splitting at end of code block
    splitAt = remaining.lastIndexOf("\n```\n", MAX_MESSAGE_LENGTH);
    if (splitAt !== -1) splitAt += 4; // include the closing ```\n

    // Then paragraph break
    if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH / 2) {
      const paraBreak = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
      if (paraBreak > MAX_MESSAGE_LENGTH / 2) splitAt = paraBreak;
    }

    // Then sentence end
    if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH / 2) {
      const sentenceEnd = remaining.lastIndexOf(". ", MAX_MESSAGE_LENGTH);
      if (sentenceEnd > MAX_MESSAGE_LENGTH / 2) splitAt = sentenceEnd + 1;
    }

    // Fallback: hard cut
    if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH / 4) {
      splitAt = MAX_MESSAGE_LENGTH;
    }

    const chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).trimStart();

    // Handle unclosed code blocks
    const backtickCount = (chunk.match(/```/g) || []).length;
    if (backtickCount % 2 !== 0) {
      // Odd = unclosed code block
      messages.push(chunk + "\n```");
      remaining = "```\n" + remaining;
    } else {
      messages.push(chunk);
    }
  }

  return messages.filter((m) => m.trim().length > 0);
}

/**
 * Cleans up the response text for Discord.
 * Strips any leading/trailing whitespace and limits consecutive newlines.
 */
export function cleanResponse(text: string): string {
  return text
    .trim()
    .replace(/\n{4,}/g, "\n\n\n"); // max 3 consecutive newlines
}
