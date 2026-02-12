import { Image } from "@daytonaio/sdk";

/**
 * Custom Daytona sandbox image with git, gh CLI, opencode, and bun.
 * Cached by Daytona for 24h — subsequent creates are near-instant.
 */
export function getDiscordBotImage() {
  return Image.base("node:22-bookworm-slim")
    .runCommands(
      "apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*",
      "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && echo \"deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*",
      "npm install -g opencode-ai@latest bun",
    )
    .workdir("/home/daytona");
}
