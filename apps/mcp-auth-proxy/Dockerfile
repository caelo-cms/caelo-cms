# SPDX-License-Identifier: MPL-2.0
#
# Caelo CMS — MCP-Auth-Proxy (issue #1328).
#
# The public service that signs external AI apps in with the install's
# Google sign-in client and streams their MCP requests through IAP to the
# admin. It sees the operators' Google ID tokens, so the image carries as
# little as possible (the minimal-image pattern of #1327):
#
#   - one bundled file (`bun build`), no node_modules, no workspace, no
#     package manager: the import lint (src/no-db-imports.test.ts) keeps
#     database, admin and plugin code out of the bundle;
#   - a distroless runtime with nothing but libc, CA certificates and the
#     Bun binary — no shell, so there is nothing to drop into;
#   - a non-root user (distroless `nonroot`, 65532);
#   - both base images pinned by digest (Dependabot moves them).
#
# CLAUDE.md §11.C: published to ghcr.io/caelo-cms/mcp-auth-proxy by
# .github/workflows/release-images.yml on every release. The release
# version is the committed CAELO_VERSION (packages/shared/src/version.ts,
# set by scripts/release.ts), baked into the bundle — no build argument.

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder

WORKDIR /repo

# Only the workspaces the proxy imports. bunfig.toml pins the hoisted
# linker (see the admin Dockerfile); `--frozen-lockfile` installs exactly
# the locked versions of what these workspaces need.
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/mcp-auth-proxy/package.json apps/mcp-auth-proxy/
RUN bun install --frozen-lockfile

COPY packages/shared packages/shared/
COPY apps/mcp-auth-proxy apps/mcp-auth-proxy/

# One file, Bun's own module resolution (`bun` export conditions, so the
# shared package is bundled from its TypeScript source).
RUN bun build apps/mcp-auth-proxy/src/server.ts --target=bun --outfile=/out/server.js

# ---------------------------------------------------------------------------
FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470 AS runtime

WORKDIR /app
COPY --from=builder --chown=65532:65532 /out/server.js /app/server.js

ENV NODE_ENV=production
USER 65532:65532

# Cloud Run sets PORT=8080; Compose sets MCP_AUTH_PROXY_PORT (default 8095).
EXPOSE 8095

# Exec form; the base image's entrypoint is bun itself, so name it here
# explicitly rather than relying on it.
ENTRYPOINT ["/usr/local/bin/bun", "/app/server.js"]
