# SPDX-License-Identifier: MPL-2.0
#
# Caelo CMS — MCP server (stdio), for MCP directories that build and
# inspect servers in Docker (Glama, issue #841). Operators do not need
# it: they run `bunx @caelo-cms/mcp-server@latest` from their MCP client.
#
# Build context is THIS directory (Glama's build config points here):
#   docker build -t caelo-mcp packages/mcp-server
#
# Bun runs the TypeScript sources directly, so there is no tsc step and
# the image needs nothing from the monorepo root. Without
# CAELO_ADMIN_URL / CAELO_MCP_TOKEN the server still answers initialize
# and tools/list; every tool call then names the variables to set.
#
# Starts Power-MCP (`admin`), so an inspection shows the full tool
# catalogue (power-catalogue.json, this release's snapshot) rather than
# the three caelo_chat tools. Override the command with no argument for
# the caelo_chat server.

FROM oven/bun:1.4.3-alpine

WORKDIR /app

COPY package.json ./
RUN bun install --production --ignore-scripts

COPY power-catalogue.json ./
COPY src ./src

USER bun
ENTRYPOINT ["bun", "src/index.ts"]
CMD ["admin"]
