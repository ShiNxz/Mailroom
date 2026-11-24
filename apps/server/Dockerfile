# syntax=docker/dockerfile:1
#
# apps/server: the API (src/api.ts) and the sync worker (src/worker.ts), run from source on Bun. One image,
# two Seylo services: "api" runs the default command, "worker" sets its start command to `bun src/worker.ts`.
#
# Seylo: App service, build type Dockerfile, build context = repo root, Dockerfile = apps/server/Dockerfile.
# Locally, from the repo root:
#   docker build -f apps/server/Dockerfile -t mailroom-server .
#
# Env comes from the service, never from the image: DATABASE_URL, REDIS_URL, APP_SECRET, optionally
# SETUP_TOKEN (see apps/server/.env.example). Both listen on PORT for /health (api 3001, worker 3002).
# Migrations run on start, under a Postgres advisory lock.

# ---------------------------------------------------------------------------
# Only the files `bun install` reads, so the install layers stay cached across code changes. Every
# workspace manifest is needed: --frozen-lockfile compares bun.lock with all of them.
FROM oven/bun:1.4.4-slim AS manifests
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/

# ---------------------------------------------------------------------------
# The type check is the build step: a type error fails the image.
FROM manifests AS check
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
	bun install --frozen-lockfile --filter @mailroom/server
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN bun run --cwd apps/server typecheck && touch /checked

# ---------------------------------------------------------------------------
FROM manifests AS prod
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
	bun install --frozen-lockfile --production --filter @mailroom/server
COPY packages/shared packages/shared
COPY apps/server apps/server

# ---------------------------------------------------------------------------
FROM oven/bun:1.4.4-slim AS runtime
# Makes the runtime stage depend on the type check, so BuildKit can't skip it
COPY --from=check /checked /tmp/checked
WORKDIR /app
COPY --from=prod --chown=bun:bun /app ./
ENV NODE_ENV=production \
	PORT=3001
WORKDIR /app/apps/server
USER bun
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health', { signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "src/api.ts"]
