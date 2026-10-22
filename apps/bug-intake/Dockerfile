# SPDX-License-Identifier: MPL-2.0
#
# Caelo bug intake (epic #901) — the Caelo-operated service installs send
# AI-detected bug reports to. Not part of an install: it runs once, for the
# whole project (docs/internal/bug-intake.md).
#
# Build from the repository root:
#   docker build -f apps/bug-intake/Dockerfile -t bug-intake .

ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION} AS builder

WORKDIR /repo

# `--frozen-lockfile` needs every workspace manifest to match bun.lock, so
# the whole tree is copied (same reasoning as packages/provisioning/Dockerfile.ops);
# `--filter` then installs only the intake's closure.
COPY . .
RUN bun install --frozen-lockfile --production --filter @caelo-cms/bug-intake && \
    mkdir -p /opt/bug-intake/packages/shared /opt/bug-intake/apps/bug-intake && \
    cp package.json /opt/bug-intake/ && \
    cp -a node_modules /opt/bug-intake/ && \
    cp -a packages/shared/package.json packages/shared/src /opt/bug-intake/packages/shared/ && \
    cp -a apps/bug-intake/package.json apps/bug-intake/src /opt/bug-intake/apps/bug-intake/ && \
    if [ -d apps/bug-intake/node_modules ]; then cp -a apps/bug-intake/node_modules /opt/bug-intake/apps/bug-intake/; fi && \
    find /opt/bug-intake -name '*.test.ts' -delete

FROM oven/bun:${BUN_VERSION}-slim AS runtime

WORKDIR /app
COPY --from=builder /opt/bug-intake ./

ENV NODE_ENV=production
EXPOSE 8080
USER bun

# Bun runs the TypeScript source directly; @caelo-cms/shared resolves to its
# src/ through the `bun` export condition.
CMD ["bun", "apps/bug-intake/src/main.ts"]
