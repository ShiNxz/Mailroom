# syntax=docker/dockerfile:1
#
# apps/web: the Next.js app, built with Bun, served by Node from Next's standalone output. Every /api/*
# request is passed on to the API service (app/api/[...path]/route.ts), so this is the only service
# that needs a domain.
#
# Seylo: App service, build type Dockerfile, build context = repo root, Dockerfile = apps/web/Dockerfile.
# Locally, from the repo root:
#   docker build -f apps/web/Dockerfile -t mailroom-web .
#
# Env: API_URL, the API service's internal address (e.g. http://api:3001). Read at runtime, so
# no build args are needed and changing it takes a restart, not a rebuild. Listens on PORT, 3000.

# ---------------------------------------------------------------------------
FROM oven/bun:1.4.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
	bun install --frozen-lockfile --filter @mailroom/web

# ---------------------------------------------------------------------------
# Only here to hand its node binary to the build stage: `next build` runs on the same Node as the
# runtime image below.
FROM node:26.12.1-trixie-slim AS node

# ---------------------------------------------------------------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1 \
	NEXT_OUTPUT=standalone
# The oven/bun image's `node` is a symlink to bun at the end of PATH; the real Node goes first.
# Node 25+ links libatomic, which the node image ships and the slim bun image doesn't.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends libatomic1 \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# next build type-checks too, so a type error fails the image. It also downloads the Inter font.
RUN bun run --cwd apps/web build

# ---------------------------------------------------------------------------
# The standalone folder mirrors the monorepo (apps/web/server.js next to a traced node_modules).
# .next/static is not part of the trace and is copied in.
FROM node:26.12.1-trixie-slim AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# public/ is not traced either: it holds the service worker (sw.js) for push notifications
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
# HOSTNAME: Docker sets it to the container id, and Next's standalone server binds to it.
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	PORT=3000 \
	HOSTNAME=0.0.0.0 \
	API_URL=http://localhost:3001
WORKDIR /app/apps/web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/login', { signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
