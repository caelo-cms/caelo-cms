#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * sign-tier1-manifest — emit `manifest.json` + `manifest.sig` (+ the
 * `.tier1-trust-root` drop file) for each Tier-1 plugin under
 * `packages/plugins/`.
 *
 * Thin CLI over `ensureDevSignedManifests` (@caelo-cms/plugin-host) —
 * the SAME code the admin/gateway hosts run at non-production boot and
 * the image build runs at bake time, so the script can't drift from
 * what the loaders verify (#387).
 *
 * Modes:
 *   bun run scripts/sign-tier1-manifest.ts           # dev key from .caelo-dev-key
 *   bun run scripts/sign-tier1-manifest.ts --new-key # generates a fresh dev pair
 *   CAELO_TIER1_PRIVATE_KEY=<hex> CAELO_TIER1_PUBLIC_KEY=<hex> bun run scripts/...
 *                                                    # sign with the CI/release pair
 *
 * Each plugin must have built `dist/index.js` first (`tsc -b` in the
 * plugin dir or the workspace build).
 */

import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { type DevKeyPair, ensureDevSignedManifests } from "@caelo-cms/plugin-host";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PLUGINS_ROOT = resolve(REPO_ROOT, "packages/plugins");
const DEV_KEY_PATH = resolve(REPO_ROOT, ".caelo-dev-key");

async function main(): Promise<void> {
  const forceNew = process.argv.includes("--new-key");
  if (forceNew && existsSync(DEV_KEY_PATH)) unlinkSync(DEV_KEY_PATH);

  let key: DevKeyPair | undefined;
  const envPriv = process.env.CAELO_TIER1_PRIVATE_KEY;
  const envPub = process.env.CAELO_TIER1_PUBLIC_KEY;
  if (envPriv && envPub) {
    key = { privateKeyHex: envPriv, publicKeyHex: envPub };
  }

  const { publicKeyHex, reports } = await ensureDevSignedManifests({
    pluginsRoot: PLUGINS_ROOT,
    keyPath: DEV_KEY_PATH,
    key,
  });
  console.log(`Using public key ${publicKeyHex}`);
  for (const r of reports) {
    const tag = r.status === "failed" ? "!!" : r.status === "skipped" ? "--" : "OK";
    console.log(`[${tag}] ${r.slug} (${r.status})${r.reason ? ` — ${r.reason}` : ""}`);
  }
  const failed = reports.filter((r) => r.status === "failed");
  if (failed.length > 0) process.exit(1);
  console.log(
    `\nThe loader picks the trust root up from packages/plugins/.tier1-trust-root automatically.`,
  );
}

if (import.meta.main) {
  await main();
}
