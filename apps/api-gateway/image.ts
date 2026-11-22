// SPDX-License-Identifier: MPL-2.0

/**
 * What the API gateway image contains (issue #1327). Read by
 * `scripts/service-image.ts`: `stage` builds the app tree from it inside
 * apps/api-gateway/Dockerfile, `verify` checks the built image against it in
 * CI (every file the image adds to its distroless base must be listed here).
 *
 * The gateway is the one service that takes untrusted traffic (CLAUDE.md
 * §11.B Tier 3). #1340 (epic #763 E2-B): it runs no plugin code, so it
 * carries its bundled server and, of the plugins, only data:
 *
 *   - each release-signed plugin's manifest and signature, and the trust
 *     root the image build signed them with (#387) — the gateway attaches a
 *     plugin as its verified manifest and runs its declarations with core
 *     code (plugin-host manifest-definition.ts, public-run-host.ts).
 *   - #1650: the embedding models of the core catalog and ONNX Runtime's
 *     WebAssembly build (`ort-wasm-simd-threaded.{wasm,mjs}`, loaded from
 *     CAELO_ORT_WASM_DIR; its JavaScript is in the bundle). No native
 *     inference code: a visitor's query runs inside WebAssembly.
 *
 * No plugin dist, no Deno, no plugin validator (oxc-parser) and no package
 * a plugin would import at run time: the bundle is the whole program.
 */

import { EMBEDDING_MODELS } from "../../packages/shared/src/embedding-models.ts";
import type { ServiceImageSpec } from "../../scripts/service-image.ts";

/**
 * #1650 — the catalog's embedding models, under /opt/caelo/models (the
 * Dockerfile's `models` stage fetched and verified them): each graph with a
 * package URL, so the image's SBOM names the model at its revision, and its
 * tokenizer and licence notice beside it.
 */
const modelGraphs = EMBEDDING_MODELS.map((m) => ({
  path: `opt/caelo/models/${m.id}/${m.source.revision}/${m.files.model.name}`,
  purl: `pkg:huggingface/${m.source.repo}@${m.source.revision}`,
}));
const modelData = EMBEDDING_MODELS.flatMap((m) =>
  [m.files.tokenizer.name, "NOTICE.txt"].map(
    (f) => `opt/caelo/models/${m.id}/${m.source.revision}/${f}`,
  ),
);

const spec: ServiceImageSpec = {
  dockerfile: "apps/api-gateway/Dockerfile",
  appRoot: "/app",
  bundle: {
    entrypoints: ["apps/api-gateway/src/server.ts", "apps/api-gateway/src/image-self-check.ts"],
    // Same depth as src/: the bundle resolves packages/plugins relative to
    // its own directory (src/plugins-root.ts).
    outdir: "apps/api-gateway/dist",
    external: [],
  },
  // #1340 — nothing is resolved from disk at run time.
  runtimePackages: [],
  // gcr.io/distroless/cc-debian13 (the Dockerfile's runtime base).
  libc: "glibc",
  nodeModules: [],
  copy: [
    "packages/plugins/.tier1-trust-root",
    "packages/plugins/*/manifest.json",
    "packages/plugins/*/manifest.sig",
    "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
  ],
  binaries: [
    // No advisory database tracks Bun releases; the builder's digest-pinned
    // oven/bun tag is its version, bumped by Dependabot.
    { path: "usr/local/bin/bun", purl: null },
    ...modelGraphs,
  ],
  // #1338 — the database CA bundles every verify-full URL names as
  // `sslrootcert` (packages/shared database-tls.ts DATABASE_CA_DIR), copied by
  // the Dockerfile from packages/shared/certs/. Required: without them the
  // gateway cannot open a single database connection.
  extraFiles: ["etc/caelo/db-ca/*", ...modelData],
  require: [
    "etc/caelo/db-ca/*.pem",
    "usr/local/bin/bun",
    "app/apps/api-gateway/dist/server.js",
    "app/apps/api-gateway/dist/image-self-check.js",
    "app/packages/plugins/.tier1-trust-root",
    "app/packages/plugins/*/manifest.json",
    "app/packages/plugins/*/manifest.sig",
    "app/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    "app/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
    ...modelGraphs.map((f) => f.path),
    ...modelData,
  ],
};

export default spec;
