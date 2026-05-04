# SPDX-License-Identifier: MPL-2.0
#
# Caelo CMS — admin app runtime image.
#
# The SvelteKit admin's `apps/admin/build/` output is built natively on
# the GitHub Actions runner before this Dockerfile runs (see the
# release-images workflow's "Pre-build admin" step). Building Vite +
# Rollup native bindings inside Docker buildx + Bun runs into two
# upstream gaps (Bun's transitive optionalDependencies + `bun --bun`
# JIT instructions the runner CPU rejects), so we side-step both by
# building outside the container and only carrying the artifacts in.
#
# CLAUDE.md §11.C: this image is published to ghcr.io/caelo-cms/admin
# by .github/workflows/release-images.yml on every release. End-users
# never build it themselves.

FROM oven/bun:1.3-slim AS runtime

WORKDIR /app

# Install only the runtime dependency closure. The Bun adapter emits
# bundled output but the workspace + the Postgres driver + the plugin
# host all import packages at runtime that aren't inlined.
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

# --production drops devDependencies (Vite, TypeScript, etc.) — none
# needed at runtime since the bundle is pre-built.
RUN bun install --production --frozen-lockfile

# Pre-built SvelteKit output from the runner-native build step.
COPY apps/admin/build ./apps/admin/build

# Workspace source the runtime needs (Tier-1 plugin manifests, the
# migrations directory the admin runs at boot, shared TS files the
# adapter resolves at runtime).
COPY packages/migrations packages/migrations
COPY packages/plugins packages/plugins
COPY packages/admin-core packages/admin-core
COPY packages/shared packages/shared
COPY packages/query-api packages/query-api
COPY packages/plugin-host packages/plugin-host
COPY packages/plugin-sandbox packages/plugin-sandbox
COPY packages/plugin-sdk packages/plugin-sdk

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

WORKDIR /app/apps/admin
CMD ["bun", "--bun", "build/index.js"]
