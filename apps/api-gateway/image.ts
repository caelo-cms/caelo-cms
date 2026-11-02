// SPDX-License-Identifier: MPL-2.0

/**
 * What the API gateway image contains (issue #1327). Read by
 * `scripts/service-image.ts`: `stage` builds the app tree from it inside
 * apps/api-gateway/Dockerfile, `verify` checks the built image against it in
 * CI (every file the image adds to its distroless base must be listed here).
 *
 * The gateway is the one service that takes untrusted traffic (CLAUDE.md
 * §11.B Tier 3), so it carries its bundled server and, until plugins leave
 * the gateway (E2-B, v0.13), what plugins need at run time:
 *
 *   - the release-signed plugin dists, their manifests and the trust root
 *     the image build signed them with (#387);
 *   - the packages those dists import (`@caelo-cms/plugin-sdk`,
 *     `@caelo-cms/plugin-component-kit`) and their closure. The sandbox
 *     bundler inlines the same two SDK packages into every runtime-authored
 *     plugin it hands to Deno (plugin-host sandbox-runtime.ts), so they
 *     must exist as files, not only inside the bundle;
 *   - oxc-parser with its native binding, which the plugin validator loads
 *     (it cannot be bundled);
 *   - the Deno binary (`/usr/local/bin/deno`), the sandbox runtime.
 */

import type { ServiceImageSpec } from "../../scripts/service-image.ts";

const spec: ServiceImageSpec = {
  dockerfile: "apps/api-gateway/Dockerfile",
  appRoot: "/app",
  bundle: {
    entrypoints: ["apps/api-gateway/src/server.ts", "apps/api-gateway/src/image-self-check.ts"],
    // Same depth as src/: the bundle resolves packages/plugins relative to
    // its own directory (src/plugins-root.ts).
    outdir: "apps/api-gateway/dist",
    external: ["oxc-parser"],
  },
  runtimePackages: ["@caelo-cms/plugin-sdk", "@caelo-cms/plugin-component-kit", "oxc-parser"],
  // gcr.io/distroless/cc-debian13 (the Dockerfile's runtime base).
  libc: "glibc",
  nodeModules: [
    "node_modules/@caelo-cms/plugin-component-kit",
    "node_modules/@caelo-cms/plugin-sdk",
    "node_modules/@caelo-cms/shared",
    // The binding for the image's platform (linux, glibc); the runtime base is Debian.
    "node_modules/@oxc-parser/binding-linux-*-gnu",
    "node_modules/@oxc-project/types",
    "node_modules/colorjs.io",
    "node_modules/dom-serializer",
    "node_modules/domelementtype",
    "node_modules/domhandler",
    "node_modules/domutils",
    "node_modules/entities",
    "node_modules/htmlparser2",
    "node_modules/mustache",
    "node_modules/oxc-parser",
    "node_modules/zod",
  ],
  copy: [
    "packages/plugins/.tier1-trust-root",
    "packages/plugins/*/package.json",
    "packages/plugins/*/manifest.json",
    "packages/plugins/*/manifest.sig",
    "packages/plugins/*/dist/**/*.js",
  ],
  binaries: [
    // No advisory database tracks Bun releases; the builder's digest-pinned
    // oven/bun tag is its version, bumped by Dependabot.
    { path: "usr/local/bin/bun", purl: null },
    // GitHub advisories file Deno under its crate; the version must equal the
    // Dockerfile's denoland/deno:bin-<version> (scripts/service-image.test.ts).
    { path: "usr/local/bin/deno", purl: "pkg:cargo/deno@2.9.8" },
  ],
  require: [
    "usr/local/bin/bun",
    "usr/local/bin/deno",
    "app/apps/api-gateway/dist/server.js",
    "app/apps/api-gateway/dist/image-self-check.js",
    "app/packages/plugins/.tier1-trust-root",
    "app/packages/plugins/*/manifest.sig",
    "app/node_modules/@oxc-parser/binding-*/*.node",
  ],
};

export default spec;
