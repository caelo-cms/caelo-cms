# SPDX-License-Identifier: MPL-2.0
#
# Caelo CMS — MCP-Auth-Proxy (issue #1328).
#
# The public service that signs external AI apps in with the install's
# Google sign-in client and streams their MCP requests through IAP to the
# admin. It sees the operators' Google ID tokens, so the image is minimal
# in the shape of the gateway's (issue #1327):
#
#   - the server is one Bun bundle (apps/mcp-auth-proxy/dist), no
#     node_modules: the import lint (src/no-db-imports.test.ts) keeps
#     database, admin and plugin code out of it;
#   - the runtime base is distroless (no shell, no package manager), pinned
#     by digest, and the process runs as its non-root user 65532;
#   - every file the image adds to that base is allowlisted in
#     apps/mcp-auth-proxy/image.ts, and CI refuses an image with anything
#     else (`scripts/service-image.ts verify`), with a high/critical Trivy
#     finding, or that does not boot (release-images.yml).
#
# Every FROM is pinned by digest; Dependabot (docker ecosystem) proposes the
# bumps. The same `cc` distroless variant as the gateway, so both public
# services share one base to patch.
#
# CLAUDE.md §11.C: published to ghcr.io/caelo-cms/mcp-auth-proxy by
# .github/workflows/release-images.yml on every release.

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

# Bundle the server and stage the app tree: exactly what image.ts lists.
COPY scripts/service-image.ts scripts/
RUN bun scripts/service-image.ts stage apps/mcp-auth-proxy/image.ts /stage

# ---------------------------------------------------------------------------
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cc66d222f0a7ec996b78a99fe76a969bc80b539a5016ad866c14d1949bc6d0ab AS runtime

COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
# Owned by root and not writable by the service user: the app is immutable
# at run time.
COPY --from=builder /stage/app /app

WORKDIR /app

ENV NODE_ENV=production
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

USER 65532:65532

# Cloud Run injects PORT=8080; Compose sets MCP_AUTH_PROXY_PORT (8095).
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["apps/mcp-auth-proxy/dist/server.js"]
