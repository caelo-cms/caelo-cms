// SPDX-License-Identifier: MPL-2.0

/**
 * What the MCP-Auth-Proxy image contains (#1328), in the P2 shape of
 * apps/api-gateway/image.ts (issue #1327). Read by `scripts/service-image.ts`:
 * `stage` builds the app tree from it inside apps/mcp-auth-proxy/Dockerfile,
 * `verify` checks the built image against it in CI.
 *
 * The proxy is one bundled server and nothing else: no package resolved from
 * disk, no Deno, no plugin dists and no database CA bundle — it holds no
 * database login (its import lint, src/no-db-imports.test.ts).
 */

import type { ServiceImageSpec } from "../../scripts/service-image.ts";

const spec: ServiceImageSpec = {
  dockerfile: "apps/mcp-auth-proxy/Dockerfile",
  appRoot: "/app",
  bundle: {
    entrypoints: ["apps/mcp-auth-proxy/src/server.ts"],
    outdir: "apps/mcp-auth-proxy/dist",
    external: [],
  },
  runtimePackages: [],
  // gcr.io/distroless/cc-debian13 (the Dockerfile's runtime base, the gateway's).
  libc: "glibc",
  nodeModules: [],
  copy: [],
  binaries: [
    // No advisory database tracks Bun releases; the builder's digest-pinned
    // oven/bun tag is its version, bumped by Dependabot.
    { path: "usr/local/bin/bun", purl: null },
  ],
  extraFiles: [],
  require: ["usr/local/bin/bun", "app/apps/mcp-auth-proxy/dist/server.js"],
};

export default spec;
