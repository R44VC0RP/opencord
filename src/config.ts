import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  ALLOWED_CHANNEL_IDS: z.string().default("").transform((s) =>
    s
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ),
  DISCORD_CATEGORY_ID: z.string().default(""),
  DISCORD_ROLE_ID: z.string().default(""),
  DISCORD_REQUIRED_ROLE_ID: z.string().default(""),
  DATABASE_URL: z.string().min(1),
  DAYTONA_API_KEY: z.string().min(1),
  OPENCODE_ZEN_API_KEY: z.string().min(1),
  GITHUB_TOKEN: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_PRETTY: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  HEALTH_HOST: z.string().default("0.0.0.0"),
  HEALTH_PORT: z.coerce.number().default(8787),
  TURN_ROUTING_MODE: z.enum(["off", "heuristic", "ai"]).default("ai"),
  TURN_ROUTING_MODEL: z.string().default("claude-haiku-4-5"),
  SANDBOX_REUSE_POLICY: z.enum(["resume_preferred", "recreate"]).default("resume_preferred"),
  SANDBOX_TIMEOUT_MINUTES: z.coerce.number().default(30),
  PAUSED_TTL_MINUTES: z.coerce.number().default(180),
  RESUME_HEALTH_TIMEOUT_MS: z.coerce.number().default(120000),
  SANDBOX_CREATION_TIMEOUT: z.coerce.number().default(180),
  OPENCODE_MODEL: z.string().default("opencode/claude-sonnet-4-5"),
});

export type Env = z.infer<typeof envSchema>;

let _config: Env | null = null;

export function getEnv(): Env {
  if (!_config) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "config.invalid",
        component: "config",
        message: "Invalid environment variables",
        fieldErrors: result.error.flatten().fieldErrors,
      }));
      throw new Error("Invalid environment configuration");
    }
    _config = result.data;
  }
  return _config;
}
