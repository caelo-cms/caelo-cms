# SPDX-License-Identifier: MPL-2.0
#
# Caelo CMS — admin app.
#
# Multi-stage build. Builder stage installs the workspace, manually
# fetches the Rollup native binding (Bun's transitive optional-deps
# gap, oven-sh/bun#14918), and runs the SvelteKit build under Bun's
# own runtime so the `bun` virtual import resolves. Runtime stage
# carries only the production closure.
#
# CLAUDE.md §11.C: this image is published to ghcr.io/caelo-cms/admin
# by .github/workflows/release-images.yml. End-users never build it.

FROM oven/bun:1.3 AS builder

# npm is needed to work around Bun's transitive optionalDependencies gap
# (oven-sh/bun#14918). Bun fails to install Rollup's per-platform native
# binding even when listed; npm handles it correctly. We use npm only to
# fix up the rollup install — Bun stays the workspace package manager.
RUN apt-get update && apt-get install -y --no-install-recommends npm && rm -rf /var/lib/apt/lists/*

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

RUN bun install

# Patch up the missing Rollup native binding via npm. npm correctly
# installs the binary; Bun's transitive-optionalDependencies gap
# (oven-sh/bun#14918) drops it. We run npm in an isolated /tmp dir so
# it doesn't see the workspace's `workspace:*` protocol (which npm
# rejects), then copy the resulting @rollup/<binding> into the place
# Vite/Rollup look (apps/admin/node_modules/@rollup/).
RUN ROLLUP_VERSION=$(grep '@rollup/rollup-linux-x64-gnu@' bun.lock | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) && \
    test -n "${ROLLUP_VERSION}" && \
    mkdir -p /tmp/rollup-bin && \
    cd /tmp/rollup-bin && \
    npm install --no-save --no-package-lock @rollup/rollup-linux-x64-gnu@${ROLLUP_VERSION} && \
    mkdir -p /repo/apps/admin/node_modules/@rollup && \
    rm -rf /repo/apps/admin/node_modules/@rollup/rollup-linux-x64-gnu && \
    cp -r /tmp/rollup-bin/node_modules/@rollup/rollup-linux-x64-gnu /repo/apps/admin/node_modules/@rollup/ && \
    echo "Installed @rollup/rollup-linux-x64-gnu@${ROLLUP_VERSION}" && \
    ls /repo/apps/admin/node_modules/@rollup/rollup-linux-x64-gnu/

# Now the source.
COPY . .

# Build under Bun's runtime (`bun --bun`) so the `bun` virtual import
# resolves at SSR build time. We're inside oven/bun:1.3 on linux/amd64,
# so the SIGILL we saw on GitHub Actions runners doesn't apply here.
RUN cd apps/admin && bun --bun vite build

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime

WORKDIR /app

COPY --from=builder /repo/apps/admin/build ./build
COPY --from=builder /repo/apps/admin/package.json ./package.json
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/migrations ./packages/migrations
COPY --from=builder /repo/packages/plugins ./packages/plugins

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "--bun", "build/index.js"]
