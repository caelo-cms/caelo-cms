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
RUN set -e && \
    mkdir -p /tmp/native-bin && cd /tmp/native-bin && \
    BINDINGS=$(grep -oE '"[a-zA-Z0-9@/_.-]*-linux-x64-gnu@[0-9.]+' /repo/bun.lock | sed 's/^"//' | sort -u) && \
    test -n "${BINDINGS}" || (echo "no linux-x64-gnu bindings found in bun.lock" && exit 1) && \
    for SPEC in ${BINDINGS}; do \
      echo "Installing native binding: ${SPEC}"; \
      npm install --no-save --no-package-lock "${SPEC}"; \
    done && \
    cd /tmp/native-bin/node_modules && \
    for ENTRY in $(find . -maxdepth 2 -name "*-linux-x64-gnu" -type d); do \
      DEST="/repo/apps/admin/node_modules/${ENTRY#./}"; \
      mkdir -p "$(dirname "${DEST}")"; \
      rm -rf "${DEST}"; \
      cp -r "${ENTRY}" "${DEST}"; \
      echo "Copied ${ENTRY} → ${DEST}"; \
    done

# Now the source.
COPY . .

# Several runtime packages (query-api/adapter.ts, admin-core/media/storage.ts)
# import from Bun's virtual `bun` module (SQL, Glob). At runtime under Bun
# this resolves natively. At build time, when svelte-adapter-bun spawns a
# Worker to inspect the SSR chunks under Node, those bare `import "bun"`
# statements crash the Worker. Drop a no-op stub in node_modules/bun so
# Node's resolver finds something; Bun's runtime ignores node_modules/bun
# in favour of its built-in virtual module, so production behaviour is
# unchanged.
RUN mkdir -p /repo/node_modules/bun && \
    printf '{"name":"bun","version":"0.0.0-stub","type":"module","main":"index.js"}\n' \
      > /repo/node_modules/bun/package.json && \
    printf 'const stub = () => { throw new Error("bun stub: should never be called outside Bun runtime"); };\nexport const SQL = stub;\nexport const Glob = stub;\nexport default {};\n' \
      > /repo/node_modules/bun/index.js

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
