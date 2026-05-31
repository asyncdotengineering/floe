###
### Dockerfile for templates/ops-bot — runs the Floe ops-bot template
### as a single Node process (mock MCPs are co-located in the same
### process on internal localhost ports 4001-4003).
###
### Build context MUST be the monorepo root so the pnpm workspace can
### resolve workspace deps:
###   docker build -f templates/ops-bot/Dockerfile -t ops-bot:latest .
### or via fly:
###   fly deploy -c templates/ops-bot/fly.toml --dockerfile templates/ops-bot/Dockerfile
###
### The image installs the whole pnpm workspace (small enough for v1;
### slim down later with `pnpm deploy --filter ops-bot`).
###
# ── Build stage ─────────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Enable pnpm via corepack (the version pinned in the lockfile).
RUN corepack enable

# Copy the workspace skeleton first so deps install can layer-cache.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# Copy workspace package manifests (no source yet) so pnpm can resolve.
# Adding *.json to each path lets pnpm see the package metadata without
# invalidating the cache on every code change.
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/server-bootstrap/package.json ./packages/server-bootstrap/
COPY packages/adapter-web/package.json ./packages/adapter-web/
COPY packages/adapter-slack/package.json ./packages/adapter-slack/
COPY packages/mock-services/package.json ./packages/mock-services/
COPY packages/inbox/package.json ./packages/inbox/
COPY packages/state-libsql/package.json ./packages/state-libsql/
COPY packages/bench-harness/package.json ./packages/bench-harness/
COPY packages/jobs/package.json ./packages/jobs/
COPY templates/ops-bot/package.json ./templates/ops-bot/

# Install all workspace deps (frozen lockfile = reproducible builds).
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Source stage ────────────────────────────────────────────────────
FROM deps AS source

# Now copy the actual source for the packages ops-bot transitively uses.
COPY packages/runtime ./packages/runtime
COPY packages/server-bootstrap ./packages/server-bootstrap
COPY packages/adapter-web ./packages/adapter-web
COPY packages/adapter-slack ./packages/adapter-slack
COPY packages/mock-services ./packages/mock-services
COPY templates/ops-bot ./templates/ops-bot

# ── Runtime stage ───────────────────────────────────────────────────
FROM source AS runtime

# Fly sets PORT automatically (defaults to 8080); ops-bot's
# `runServer(...)` reads PORT from env. Mock MCPs use internal ports
# 4001-4003 inside the container (not exposed externally).
ENV NODE_ENV=production
EXPOSE 8080

# tsx runs server.ts directly — no separate build step needed.
WORKDIR /app/templates/ops-bot
CMD ["pnpm", "start"]
