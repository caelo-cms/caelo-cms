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

# curl is needed to fetch the Rollup native binding tarball below.
# oven/bun:1.3 is debian-slim and doesn't include curl by default.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

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

# Bun has a documented gap with transitive optionalDependencies
# (oven-sh/bun#14918): Vite declares Rollup as a non-optional dep, but
# Rollup's per-platform binary ships as one of Rollup's OWN
# optionalDependencies — Bun doesn't install those transitively. Local
# dev never hits this because `vite dev` uses esbuild, not Rollup. The
# `vite build` path needs the binary. Workaround: pin to the version
# resolved in bun.lock and fetch the tgz directly into the apps/admin
# nested node_modules where Bun installs Vite.
RUN ROLLUP_VERSION=$(grep '@rollup/rollup-linux-x64-gnu@' bun.lock | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) && \
    test -n "${ROLLUP_VERSION}" || (echo "could not parse rollup version from bun.lock" && exit 1) && \
    echo "Resolving Rollup native binding @${ROLLUP_VERSION}" && \
    BIN_PKG=@rollup/rollup-linux-x64-gnu && \
    BIN_DIR=apps/admin/node_modules/${BIN_PKG} && \
    mkdir -p "${BIN_DIR}" && \
    curl -sSL "https://registry.npmjs.org/${BIN_PKG}/-/rollup-linux-x64-gnu-${ROLLUP_VERSION}.tgz" \
      | tar -xz --strip-components=1 -C "${BIN_DIR}" && \
    cd apps/admin && bun add --no-save rollup@${ROLLUP_VERSION}

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
