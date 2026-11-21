# SPDX-License-Identifier: MPL-2.0
#
# Caelo CMS — API gateway.
#
# Public-facing HTTP entry point for visitor writes (form submissions,
# comments, newsletter signups). Remote MCP is the MCP-Auth-Proxy's
# (apps/mcp-auth-proxy, #1328). It takes untrusted visitor traffic (CLAUDE.md §11.B Tier 3), so the
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
# #1340 (epic #763 E2-B): it runs no plugin code. Of the plugins it carries
# only their signed manifests and the trust root (data the gateway attaches
# plugins from); no plugin dist, no Deno, no plugin validator — see image.ts.
#
# Every FROM is pinned by digest; Dependabot (docker ecosystem) proposes the
# bumps. The `cc` distroless variant for the C++ runtime Bun links.
#
# CLAUDE.md §11.C: published to ghcr.io/caelo-cms/gateway by the
# .github/workflows/release-images.yml workflow on every release.

# #1650 — the core catalog's embedding models (packages/shared/src/
# embedding-models.ts), fetched from their pinned revisions and verified by
# SHA-256 (packages/models/scripts/fetch-models.ts): a file that is not the
# reviewed one never lands. A stage of its own over the catalog and the fetch
# code only, so it re-runs when the catalog changes; `--epoch` stamps one
# fixed time, so the same models are the same layer digest in every build
# (#1559). The script needs nothing installed but the catalog file, which
# the symlink resolves as `@caelo-cms/shared/embedding-models`. Each model
# gets its NOTICE.txt (source, revision, licence text from licenses/).
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS models
WORKDIR /repo
COPY packages/shared/package.json packages/shared/
COPY packages/shared/src/embedding-models.ts packages/shared/src/
COPY packages/models/src/fetch.ts packages/models/src/files.ts packages/models/src/
COPY packages/models/scripts/fetch-models.ts packages/models/scripts/
COPY licenses/Apache-2.0.txt licenses/MIT.txt licenses/
RUN mkdir -p node_modules/@caelo-cms && \
    ln -s ../../packages/shared node_modules/@caelo-cms/shared && \
    bun packages/models/scripts/fetch-models.ts --dir /models --licenses licenses --epoch

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
COPY packages/collection-index/package.json packages/collection-index/
COPY packages/models/package.json packages/models/
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
COPY packages/plugins/site-search/package.json packages/plugins/site-search/

RUN bun install --frozen-lockfile

COPY apps/api-gateway apps/api-gateway/
COPY packages packages/

# @caelo-cms/shared ships to npm, so its non-Bun export conditions point at
# dist/; the plugin build below resolves them.
RUN bun run --filter @caelo-cms/shared build

# #387 — build every Tier-1 plugin's dist and sign the manifests with a
# throwaway build key (mirrors the admin Dockerfile). The dists exist only in
# this builder stage, to project the manifests; the image stages the signed
# manifests and the .tier1-trust-root drop file, never a dist (#1340). The
# private half of the key is deleted in the same layer and never staged.
RUN bunx tsc -b packages/plugins/*
COPY apps/admin/scripts/sign-tier1-manifest.ts apps/admin/scripts/
RUN bun run apps/admin/scripts/sign-tier1-manifest.ts --new-key && rm -f .caelo-dev-key

# Bundle the server and stage the app tree: exactly what image.ts lists.
COPY scripts/service-image.ts scripts/
RUN bun scripts/service-image.ts stage apps/api-gateway/image.ts /stage

# ---------------------------------------------------------------------------
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cb87acc574abe719b6e5c547384defa2f7b1f24af9605d3f618cf852495d8be2 AS runtime

COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
# Owned by root and not writable by the service user: the app is immutable
# at run time.
COPY --from=builder /stage/app /app

# #1338 — the CA bundles every database URL names as sslrootcert
# (verify-full; packages/shared database-tls.ts DATABASE_CA_DIR).
COPY packages/shared/certs/ /etc/caelo/db-ca/
# #1650 — the embedding models (the `models` stage). The WebAssembly runtime
# that runs them is staged by image.ts (`copy`); its JavaScript is bundled.
COPY --link --from=models /models /opt/caelo/models

WORKDIR /app

ENV NODE_ENV=production
ENV CAELO_MODELS_DIR=/opt/caelo/models
ENV CAELO_ORT_WASM_DIR=/app/node_modules/onnxruntime-web/dist
# The image is read-only for the service; Bun must not try to cache
# transpiled sources (the plugin SDK is TypeScript) under $HOME.
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

USER 65532:65532

# Cloud Run defaults to PORT=8080 (platform-injected); local Compose
# can override via GATEWAY_PORT. Server reads either.
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["apps/api-gateway/dist/server.js"]
