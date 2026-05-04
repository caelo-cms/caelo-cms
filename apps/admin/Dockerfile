# SPDX-License-Identifier: MPL-2.0
#
# Caelo CMS — admin app.
#
# Multi-stage build. Builder stage installs the full workspace + runs
# the SvelteKit build. Runtime stage carries only the production
# closure: the Bun-native adapter output + the per-package node_modules
# the runtime imports + the migrations dir (admin runs them at boot).
#
# CLAUDE.md §11.C: this image is published to ghcr.io/caelo-cms/admin
# by the .github/workflows/release-images.yml workflow on every release.
# End-users never build it themselves.

FROM oven/bun:1.3 AS builder

WORKDIR /repo

# Copy lockfile + every workspace package.json first so `bun install`
# is layer-cached against actual dependency changes, not source edits.
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY apps/admin/package.json apps/admin/
COPY apps/api-gateway/package.json apps/api-gateway/
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

# Bun has a documented gap resolving transitive optionalDependencies
# (https://github.com/oven-sh/bun/issues/14918). Vite/Rollup ships
# native bindings as optionalDependencies; on Linux x64 build platforms
# Bun fails to install @rollup/rollup-linux-x64-gnu, and the build
# crashes with "Cannot find native binding". Workaround: explicitly add
# the binary at the repo root (where Vite/Rollup are hoisted by the
# workspace install) after the main install. Gateway image is unaffected
# (no Vite/Rollup).
RUN bun install
RUN bun add --no-save @rollup/rollup-linux-x64-gnu@^4

# Now the source. Subsequent rebuilds with code-only changes hit the
# cached install layer and skip ~800 npm installs.
COPY . .

# Build the SvelteKit admin. Run vite directly (not via `bun --bun`)
# so Bun's JIT doesn't emit instructions that GitHub Actions runner
# CPUs reject with SIGILL. Output lands at apps/admin/build/index.js +
# assets via svelte-adapter-bun.
RUN cd apps/admin && bun x svelte-kit sync && bun x vite build

# ---------------------------------------------------------------------------
# Runtime stage — minimal Bun base + only what the admin needs at runtime.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime

WORKDIR /app

# The Bun adapter emits a self-contained server at apps/admin/build/.
# We also need:
#   - node_modules for runtime imports the bundle didn't inline
#   - packages/migrations/ for the schema-apply at admin boot
#   - packages/plugins/<slug>/manifest.{json,sig} for Tier-1 plugin
#     signature verification (the plugin host walks this dir at startup)
COPY --from=builder /repo/apps/admin/build ./build
COPY --from=builder /repo/apps/admin/package.json ./package.json
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/migrations ./packages/migrations
COPY --from=builder /repo/packages/plugins ./packages/plugins

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Bun's adapter-bun emits an ESM entrypoint. `bun --bun` uses Bun's
# native runtime + bundler, NOT Node, so the workspace's TypeScript
# imports + the SvelteKit runtime resolve identically to dev mode.
CMD ["bun", "--bun", "build/index.js"]
