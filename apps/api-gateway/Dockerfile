# SPDX-License-Identifier: MPL-2.0
#
# Caelo CMS — API gateway.
#
# Public-facing HTTP entry point for visitor writes (form submissions,
# comments, newsletter signups, MCP `caelo_chat`). Runs on Bun directly
# — no SvelteKit / no build step. Single source file (src/server.ts)
# with the workspace's shared deps.
#
# CLAUDE.md §11.C: published to ghcr.io/caelo-cms/gateway by the
# .github/workflows/release-images.yml workflow on every release.

FROM oven/bun:1.3 AS builder

WORKDIR /repo

COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY apps/api-gateway/package.json apps/api-gateway/
COPY apps/admin/package.json apps/admin/
COPY apps/static-generator/package.json apps/static-generator/
COPY packages/shared/package.json packages/shared/
COPY packages/query-api/package.json packages/query-api/
COPY packages/admin-core/package.json packages/admin-core/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/plugin-component-kit/package.json packages/plugin-component-kit/
COPY packages/plugin-sandbox/package.json packages/plugin-sandbox/
COPY packages/plugin-host/package.json packages/plugin-host/
COPY packages/redeploy-orchestrator/package.json packages/redeploy-orchestrator/
COPY packages/site-importer/package.json packages/site-importer/
COPY packages/edge-router/package.json packages/edge-router/
COPY packages/migrations/package.json packages/migrations/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/provisioning/package.json packages/provisioning/
COPY packages/plugins/translation/package.json packages/plugins/translation/
COPY packages/plugins/forms/package.json packages/plugins/forms/
COPY packages/plugins/comments/package.json packages/plugins/comments/
COPY packages/plugins/newsletter/package.json packages/plugins/newsletter/
COPY packages/plugins/ratings/package.json packages/plugins/ratings/
COPY packages/plugins/auth/package.json packages/plugins/auth/

RUN bun install --frozen-lockfile

# Copy gateway source + every workspace it transitively imports.
# Pulling everything keeps the workspace symlinks resolvable; Bun's
# tree-shaking discards unused code at runtime.
COPY apps/api-gateway apps/api-gateway/
COPY packages packages/

# Build @caelo-cms/shared. Mirrors the admin Dockerfile's same step.
# `shared` ships to npm so its `main` points at `./dist/index.js`; the
# gateway runs the workspace's TS source directly, but the runtime
# resolver still reads `packages/shared/package.json#main` and 404s
# without the dist/ artifacts. Build the package once so the symlink
# target carries a real `dist/` directory.
RUN bun run --filter @caelo-cms/shared build

# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime

WORKDIR /app

# Reproduce the workspace layout so Bun's nested-node_modules resolution
# matches build time (gateway-specific deps live under
# apps/api-gateway/node_modules; root only has hoisted shared deps).
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/bun.lock ./bun.lock
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/api-gateway ./apps/api-gateway

ENV NODE_ENV=production
# Cloud Run defaults to PORT=8080 (platform-injected); local Compose
# can override via GATEWAY_PORT. Server reads either.
EXPOSE 8080

# Run the TS source directly — Bun's runtime handles .ts natively, no
# transpile step. The gateway is small + the cold-start savings vs a
# pre-bundled .js are real (Cloud Run scale-to-zero defaults).
CMD ["bun", "--bun", "apps/api-gateway/src/server.ts"]
