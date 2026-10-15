# syntax=docker/dockerfile:1.6
# Agorax — production Docker image
# Publishes to ghcr.io/outsourc-e/agorax
#
# Build locally:
#   docker build -t agorax .
# Run:
#   docker run -p 6734:6734 -e HERMES_API_URL=http://host.docker.internal:8642 agorax
# Or pull pre-built:
#   docker pull ghcr.io/outsourc-e/agorax:latest
#
FROM tianon/gosu:1.17-bookworm AS gosu_source

# ─── managed-agent daemon build stage ─────────────────────────────────────
FROM golang:1.25-bookworm AS daemon-build
WORKDIR /build
COPY agorax-agent-daemon/go.work agorax-agent-daemon/go.work.sum ./
COPY agorax-agent-daemon/packages ./packages
RUN CGO_ENABLED=0 go build -o /usr/local/bin/agorax-agentd ./packages/agent/daemon/cmd/agorax-agentd

# ─── node build stage ─────────────────────────────────────────────────────
FROM node:22-slim AS build
# python3/make/g++/gcc are required when better-sqlite3 (or other native deps)
# falls back to node-gyp source compilation.
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates python3 make g++ gcc \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install deps (cache-friendly: copy only manifests first)
# NOTE: pnpm-workspace.yaml carries the allowBuilds approvals (electron/esbuild/…);
# it must be present or pnpm 10+/11 fatally errors on ignored build scripts.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile

# Copy sources and build
COPY . .
RUN pnpm build

# ─── runtime stage ────────────────────────────────────────────────────────
FROM node:22-slim
# python3 is required by scripts/pty-helper.py (terminal feature). Originally
# added in PR #185 for issue #161; regressed by the 2026-05-01 rename commit
# efcb7d14 and re-added here per issue #259.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini python3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r workspace && useradd -r -g workspace -u 10010 -m workspace

COPY --from=gosu_source /gosu /usr/local/bin/gosu
COPY --from=daemon-build --chown=workspace:workspace /usr/local/bin/agorax-agentd /usr/local/bin/agorax-agentd

WORKDIR /app

# Copy build artefacts + runtime deps.
# server-entry.js is the Node HTTP server that wraps the TanStack Start fetch
# handler exported by dist/server/server.js. Without it, `node dist/server/server.js`
# imports the handler module, runs top-level code, and exits (code 0) because
# nothing keeps the event loop alive — see issue #129.
COPY --from=build --chown=workspace:workspace /app/dist ./dist
COPY --from=build --chown=workspace:workspace /app/node_modules ./node_modules
COPY --from=build --chown=workspace:workspace /app/package.json ./package.json
COPY --from=build --chown=workspace:workspace /app/server-entry.js ./server-entry.js
COPY --from=build --chown=workspace:workspace /app/skills ./skills
COPY --chown=workspace:workspace docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=6734 \
    HOST=0.0.0.0 \
    HERMES_API_URL=http://hermes-agent:8642 \
    AGORAX_MANAGED_AGENT_URL=http://agorax-managed-agent:8788

EXPOSE 6734
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:6734/ >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--max-old-space-size=2048", "server-entry.js"]
