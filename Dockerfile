# Stage 1: Install dependencies
FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
COPY web/package.json web/
COPY discord-bot/package.json discord-bot/
RUN bun install --frozen-lockfile

# Stage 2: Production image
FROM oven/bun:1.2-alpine AS runner
WORKDIR /app

COPY package.json bun.lock* ./
COPY web/package.json web/
COPY discord-bot/package.json discord-bot/
RUN bun install --production --frozen-lockfile

# Copy shared DB schema (discord-bot imports from main project)
COPY src/db/schema.ts src/db/schema.ts

# Copy discord bot source
COPY discord-bot/src/ discord-bot/src/

CMD ["bun", "run", "discord-bot/src/index.ts"]
