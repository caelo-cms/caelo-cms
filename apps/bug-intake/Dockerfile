# SPDX-License-Identifier: MPL-2.0
#
# Caelo bug intake (epic #901) — the Caelo-operated service installs send
# AI-detected bug reports to. Not part of an install: it runs once, for the
# whole project (docs/internal/bug-intake.md).
#
# It takes signed reports from every install on the internet, so the image
# is minimal in the gateway's shape (docs/dev/service-images.md):
#
#   - the server is one Bun bundle (apps/bug-intake/dist), no node_modules.
#     That is also what makes it start fast: Cloud Run starts an instance
#     for nearly every request, and loading the source tree took about 25 s
#     at the full hour, past the 10 s an install waits;
#   - the runtime base is distroless (no shell, no package manager), pinned
#     by digest, and the process runs as its non-root user 65532;
#   - every file the image adds to that base is allowlisted in
#     apps/bug-intake/image.ts, and CI refuses an image with anything else
#     (`scripts/service-image.ts verify`), with a high/critical Trivy finding,
#     or that does not register, store and answer against a Firestore
#     emulator (bug-intake-image.yml).
#
# Every FROM is pinned by digest; Dependabot (docker ecosystem) proposes the
# bumps. The gateway's `cc` distroless variant, so the public services share
# one base to patch.
#
# Build from the repository root:
#   docker build -f apps/bug-intake/Dockerfile -t bug-intake .

FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS builder

WORKDIR /repo

# `--frozen-lockfile` needs every workspace manifest a remaining workspace
# depends on: the intake's devDependency admin-core (the contract test) pulls
# in most of the tree, so the whole tree is copied. `--production --filter`
# then installs only the intake's closure. bunfig.toml pins the hoisted
# linker (see the admin Dockerfile). None of this reaches the runtime stage.
COPY . .
RUN bun install --frozen-lockfile --production --filter @caelo-cms/bug-intake

# Bundle the server and stage the app tree: exactly what image.ts lists.
RUN bun scripts/service-image.ts stage apps/bug-intake/image.ts /stage

# ---------------------------------------------------------------------------
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cb87acc574abe719b6e5c547384defa2f7b1f24af9605d3f618cf852495d8be2 AS runtime

COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
# Owned by root and not writable by the service user: the app is immutable
# at run time.
COPY --from=builder /stage/app /app

WORKDIR /app

ENV NODE_ENV=production
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

USER 65532:65532

# Cloud Run injects PORT=8080.
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["apps/bug-intake/dist/main.js"]
