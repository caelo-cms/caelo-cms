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

# Patch up missing native bindings via npm. Bun has a documented gap
# installing transitive optionalDependencies (oven-sh/bun#14918), which
# affects every package that ships per-platform native binaries:
#   @rollup/rollup-linux-x64-gnu, @oxc-parser/binding-linux-x64-gnu,
#   @tailwindcss/oxide-linux-x64-gnu, @rolldown/binding-linux-x64-gnu,
#   lightningcss-linux-x64-gnu. Discover them all from bun.lock, install
#   in an isolated /tmp dir (so npm doesn't see workspace:* protocol),
#   then copy each into apps/admin/node_modules/.
# Bun's transitive optionalDependencies gap (oven-sh/bun#14918) skips
# the per-platform native bindings. Scan bun.lock for every package
# whose resolved spec contains "linux-x64" (matches both -linux-x64-gnu
# Rollup-style and bare -linux-x64 sharp-style) and install all of them
# via npm in /tmp (so npm doesn't see the workspace:* protocol). Then
# copy each into apps/admin/node_modules. xargs avoids the shell variable
# expansion fragility that bit a previous iteration.
RUN set -e && \
    mkdir -p /tmp/native-bin && cd /tmp/native-bin && \
    grep -oE '"[a-zA-Z0-9@/_.-]+-linux-x64(-gnu|-musl)?@[^"]+' /repo/bun.lock \
      | sed 's/^"//' | sort -u > /tmp/native-list && \
    test -s /tmp/native-list || (echo "no linux-x64 native deps found" && exit 1) && \
    echo "Installing native bindings:" && cat /tmp/native-list && \
    xargs -a /tmp/native-list npm install --no-save --no-package-lock && \
    cd /tmp/native-bin/node_modules && \
    for ENTRY in $(find . -maxdepth 2 \( -name "*-linux-x64" -o -name "*-linux-x64-gnu" -o -name "*-linux-x64-musl" \) -type d); do \
      DEST="/repo/apps/admin/node_modules/${ENTRY#./}"; \
      mkdir -p "$(dirname "${DEST}")"; \
      rm -rf "${DEST}"; \
      cp -r "${ENTRY}" "${DEST}"; \
      echo "Copied ${ENTRY} → ${DEST}"; \
    done

# Now the source.
COPY . .

# Build-time `bun` shim. Caelo source no longer value-imports "bun"
# (uses globalThis.Bun directly), but vendor code does — drizzle-orm's
# bun-sql/driver.js does `import { SQL } from "bun"` and we can't edit
# it. SvelteKit's vite/rollup bundles drizzle and tries to resolve
# "bun" at build time. Provide a shim that re-exports the runtime
# globalThis.Bun built-ins:
#   - At BUILD time: SvelteKit's adapter Worker loads the SSR chunks
#     under Node, finds the shim package, exports are undefined →
#     accessed lazily by drizzle, no errors at module-load time.
#   - At RUNTIME under Bun: globalThis.Bun is the real built-in, so
#     drizzle's `new SQL(url)` calls Bun's real constructor.
RUN mkdir -p /repo/node_modules/bun && \
    printf '{"name":"bun","version":"0.0.0-shim","type":"module","main":"index.js"}\n' \
      > /repo/node_modules/bun/package.json && \
    printf 'const G = globalThis;\nexport const SQL = G.Bun?.SQL;\nexport const Glob = G.Bun?.Glob;\nexport default G.Bun ?? {};\n' \
      > /repo/node_modules/bun/index.js

# Build @caelo-cms/shared first. Vite (running under Node) resolves
# `@caelo-cms/shared` via the symlinked workspace's package.json
# `main` → `./dist/index.js`. Without this step the dist doesn't
# exist and the build crashes with `ERR_MODULE_NOT_FOUND`. The
# shared package's `main` points at dist for npm consumers; the
# monorepo build path needs the same artifact ahead of time.
RUN bun run --filter @caelo-cms/shared build

# v0.2.18 — build every Tier-1 plugin's dist/. The plugin-host loader
# dynamic-imports `packages/plugins/<slug>/dist/index.js` at startup;
# without these built into the image, every plugin lands at
# status='failed'. .dockerignore excludes dist/ from the COPY, so the
# Dockerfile must produce them itself. tsc -b is incremental, so the
# cost is negligible after the first cached layer.
RUN bunx tsc -b \
  packages/plugins/translation \
  packages/plugins/forms \
  packages/plugins/comments \
  packages/plugins/newsletter \
  packages/plugins/ratings \
  packages/plugins/auth

# Build with `bun x vite build` (Node-style invocation, no Bun JIT).
# Bun's JIT under Docker amd64 here SIGILLs the same way it does on
# GitHub Actions runners — same Bun binary, same CPU baseline. Going
# through `bun x` runs vite as a normal subprocess that interprets its
# JS via Node-compatible execution.
RUN cd apps/admin && bun x vite build

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime

# Reproduce the workspace layout under /app so node_modules resolution
# works the same way it did at build time (Bun nests admin-specific
# deps in apps/admin/node_modules; the SSR bundle's runtime requires
# walk up from /app/apps/admin/build/server/chunks/...).
WORKDIR /app

# Workspace metadata (root + every package) so Bun knows about the
# workspace topology when the runtime resolves nested symlinks.
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/bun.lock ./bun.lock

# Repo-root node_modules (.bun/ cache + hoisted shared packages).
COPY --from=builder /repo/node_modules ./node_modules

# Workspace source the runtime needs (the bundled SSR output references
# packages/* + plugin manifests at runtime).
COPY --from=builder /repo/packages ./packages

# The pre-built SvelteKit admin output + its package.json + nested
# node_modules (admin-specific deps like clsx, bits-ui, etc.).
COPY --from=builder /repo/apps/admin/package.json ./apps/admin/package.json
COPY --from=builder /repo/apps/admin/build ./apps/admin/build
COPY --from=builder /repo/apps/admin/node_modules ./apps/admin/node_modules

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

WORKDIR /app/apps/admin
CMD ["bun", "--bun", "build/index.js"]
