#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * Bundle Caelo's Lambda@Edge handler + the latest routing-manifest.json
 * into a single CommonJS file Pulumi uploads as the L@E function source.
 *
 * Run BEFORE every `pulumi up` against the AWS stack:
 *   bun run packages/provisioning/stacks/aws/build-edge.ts \
 *     --manifest /path/to/routing-manifest.json
 *
 * The manifest path defaults to the static-output bucket's local
 * mirror (apps/static-generator/dist/routing-manifest.json) if the
 * --manifest flag is omitted.
 *
 * Why bundle the manifest IN: Lambda@Edge has no IAM role for RDS,
 * no network egress to non-AWS endpoints, no SSM access. The function
 * is pure code + bundled config. A new manifest = a new bundle = a
 * new Pulumi `update` of the Lambda function (versioned by L@E).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

// P15 hot-fix #1 — bundle the edge-router-shaped `ab-routing.json`,
// not the deploy manifest `routing-manifest.json`. The two live
// alongside each other in the static-output bucket; only the AB one
// matches @caelo-cms/edge-router's RoutingManifest shape.
const manifestPath =
  arg("manifest") ??
  resolve(import.meta.dir, "../../../..", "apps/static-generator/dist/ab-routing.json");

const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { manifestVersion: "0", experiments: [] };

console.log(`Manifest:  ${manifestPath}`);
console.log(`Version:   ${manifest.manifestVersion}`);
console.log(`Experiments: ${manifest.experiments.length}`);

const entry = resolve(import.meta.dir, "edge-handler.ts");
const out = resolve(import.meta.dir, "edge-handler-bundle.js");

// Bun's bundler: target=node, format=cjs (Lambda@Edge wants CJS),
// inline the manifest via `--define`, externalize nothing (pure JS).
const proc = Bun.spawn(
  [
    "bun",
    "build",
    entry,
    "--target=node",
    "--format=cjs",
    "--outfile",
    out,
    "--define",
    `__INLINE_MANIFEST__=${JSON.stringify(manifest)}`,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
await proc.exited;
if (proc.exitCode !== 0) {
  console.error("bun build failed");
  process.exit(proc.exitCode ?? 1);
}

const sizeKb = Math.round(readFileSync(out).byteLength / 1024);
console.log(`Wrote ${out} (${sizeKb} KB)`);
if (sizeKb > 1024) {
  console.warn(
    `Lambda@Edge has a 1 MB unzipped limit; bundle is ${sizeKb} KB. Strip dependencies before next deploy.`,
  );
}
writeFileSync(`${out}.manifest-version.txt`, String(manifest.manifestVersion));
console.log("Next: cd packages/provisioning/stacks/aws && pulumi up");
