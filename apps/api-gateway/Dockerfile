# SPDX-License-Identifier: MPL-2.0
#
# Caelo CMS — API gateway.
#
# Public-facing HTTP entry point for visitor writes (form submissions,
# comments, newsletter signups) and the remote-MCP OAuth broker. It is the
# one service that takes untrusted traffic (CLAUDE.md §11.B Tier 3), so the
# image is minimal (issue #1327):
#
#   - the server is a Bun bundle (apps/api-gateway/dist), not the monorepo;
#   - the runtime base is distroless (no shell, no package manager), pinned
#     by digest, and the process runs as its non-root user 65532;
#   - every file the image adds to that base is allowlisted in
#     apps/api-gateway/image.ts, and CI refuses an image with anything else
#     (`scripts/service-image.ts verify`), with a high/critical Trivy finding,
#     or that does not boot (release-images.yml).
#
# Until plugins leave the gateway (E2-B, v0.13) it also carries Deno, the
# signed plugin dists with their trust root, and the packages the plugin
# dists and the sandbox bundler resolve from disk — see image.ts.
#
# Every FROM is pinned by digest; Dependabot (docker ecosystem) proposes the
# bumps. The `cc` distroless variant because Deno links libgcc_s.
#
# CLAUDE.md §11.C: published to ghcr.io/caelo-cms/gateway by the
# .github/workflows/release-images.yml workflow on every release.

FROM denoland/deno:bin-2.9.8@sha256:b507583d3c68ba69f3ed2ce5969ae5b8b70f43421c781279c7aea06435263543 AS deno

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder

WORKDIR /repo

# bunfig.toml pins `linker = "hoisted"` (see admin Dockerfile for the
# load-bearing reason) — and the staging step below reproduces exactly that
# hoisted layout in the image. Both need the file before `bun install`.
COPY package.json bun.lock bunfig.toml tsconfig.base.json tsconfig.json ./
COPY apps/api-gateway/package.json apps/api-gateway/
COPY apps/admin/package.json apps/admin/
COPY apps/static-generator/package.json apps/static-generator/
COPY packages/shared/package.json packages/shared/
COPY packages/query-api/package.json packages/query-api/
COPY packages/admin-core/package.json packages/admin-core/
COPY packages/font-service/package.json packages/font-service/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/plugin-component-kit/package.json packages/plugin-component-kit/
COPY packages/plugin-sandbox/package.json packages/plugin-sandbox/
COPY packages/plugin-host/package.json packages/plugin-host/
COPY packages/site-importer/package.json packages/site-importer/
COPY packages/migrations/package.json packages/migrations/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/provisioning/package.json packages/provisioning/
COPY packages/plugins/forms/package.json packages/plugins/forms/
COPY packages/plugins/comments/package.json packages/plugins/comments/
COPY packages/plugins/newsletter/package.json packages/plugins/newsletter/
COPY packages/plugins/ratings/package.json packages/plugins/ratings/
COPY packages/plugins/auth/package.json packages/plugins/auth/
COPY packages/plugins/international-site/package.json packages/plugins/international-site/
COPY packages/plugins/consent-manager/package.json packages/plugins/consent-manager/

RUN bun install --frozen-lockfile

COPY apps/api-gateway apps/api-gateway/
COPY packages packages/

# @caelo-cms/shared ships to npm, so its non-Bun export conditions point at
# dist/. The sandbox bundler builds for the browser target and resolves
# those, so dist/ must exist before staging.
RUN bun run --filter @caelo-cms/shared build

# #387 — build every Tier-1 plugin's dist and sign the manifests with a
# throwaway build key (mirrors the admin Dockerfile). The .tier1-trust-root
# drop file carries the verification key next to the manifests; the private
# half is deleted in the same layer and never staged.
RUN bunx tsc -b packages/plugins/*
COPY apps/admin/scripts/sign-tier1-manifest.ts apps/admin/scripts/
RUN bun run apps/admin/scripts/sign-tier1-manifest.ts --new-key && rm -f .caelo-dev-key

# Bundle the server and stage the app tree: exactly what image.ts lists.
COPY scripts/service-image.ts scripts/
RUN bun scripts/service-image.ts stage apps/api-gateway/image.ts /stage

# ---------------------------------------------------------------------------
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:08476c244888bfb425bae1ae4dd7c17f093e972aab8426883d97f3c6f280f7c1 AS runtime

COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
COPY --from=deno /deno /usr/local/bin/deno
# Owned by root and not writable by the service user: the app is immutable
# at run time. The sandbox writes only to its own temp dir under /tmp.
COPY --from=builder /stage/app /app

WORKDIR /app

ENV NODE_ENV=production
# The sandbox spawns this binary directly (plugin-host sandbox-runtime.ts).
ENV CAELO_DENO_BINARY=/usr/local/bin/deno
# The image is read-only for the service; Bun must not try to cache
# transpiled sources (the plugin SDK is TypeScript) under $HOME.
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

USER 65532:65532

# Cloud Run defaults to PORT=8080 (platform-injected); local Compose
# can override via GATEWAY_PORT. Server reads either.
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["apps/api-gateway/dist/server.js"]
