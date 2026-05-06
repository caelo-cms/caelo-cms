#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * sign-tier1-manifest — emit `manifest.json` + `manifest.sig` for each
 * Tier-1 plugin under `packages/plugins/`.
 *
 * Modes:
 *   bun run scripts/sign-tier1-manifest.ts           # uses dev key from .caelo-dev-key
 *   bun run scripts/sign-tier1-manifest.ts --new-key # generates a fresh dev pair
 *   CAELO_TIER1_PRIVATE_KEY=<hex> bun run scripts/... # sign with provided key
 *
 * Dev key file `.caelo-dev-key` lives at repo root, gitignored, holds:
 *   { "publicKeyHex": "...", "privateKeyHex": "..." }
 *
 * After signing: export CAELO_TIER1_PUBLIC_KEY=<publicKeyHex> so the host
 * loader verifies against the matching key. The release pipeline replaces
 * this with the production public key embedded in plugin-sandbox/manifest.ts.
 *
 * Each plugin must have built `dist/index.js` first (run `bun run typecheck`
 * + emit declarations + JS via `tsc -b` in each plugin dir, or rely on
 * existing build).
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateManifestKeyPair, signManifest } from "@caelo-cms/plugin-sandbox";
import { type PluginDefinition, pluginManifest } from "@caelo-cms/plugin-sdk";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PLUGINS_ROOT = resolve(REPO_ROOT, "packages/plugins");
const DEV_KEY_PATH = resolve(REPO_ROOT, ".caelo-dev-key");

interface DevKey {
  publicKeyHex: string;
  privateKeyHex: string;
}

async function loadOrCreateDevKey(forceNew: boolean): Promise<DevKey> {
  if (process.env.CAELO_TIER1_PRIVATE_KEY) {
    // Trusted CI / release path. We don't know the public key without
    // re-deriving; re-generate a pair instead and ignore the env hint
    // when the public-key env isn't paired.
    const pub = process.env.CAELO_TIER1_PUBLIC_KEY;
    if (pub) {
      return { publicKeyHex: pub, privateKeyHex: process.env.CAELO_TIER1_PRIVATE_KEY };
    }
  }
  if (!forceNew && existsSync(DEV_KEY_PATH)) {
    const raw = JSON.parse(readFileSync(DEV_KEY_PATH, "utf8")) as DevKey;
    return raw;
  }
  const pair = await generateManifestKeyPair();
  writeFileSync(DEV_KEY_PATH, JSON.stringify(pair, null, 2));
  console.log(`Wrote fresh Ed25519 dev key pair to ${DEV_KEY_PATH}`);
  return pair;
}

interface SignReport {
  slug: string;
  status: "signed" | "skipped" | "failed";
  reason?: string;
}

async function signAll(devKey: DevKey): Promise<SignReport[]> {
  const reports: SignReport[] = [];
  for (const entry of readdirSync(PLUGINS_ROOT)) {
    const dir = resolve(PLUGINS_ROOT, entry);
    if (!statSync(dir).isDirectory()) continue;
    const distEntry = resolve(dir, "dist/index.js");
    if (!existsSync(distEntry)) {
      reports.push({
        slug: entry,
        status: "skipped",
        reason:
          "dist/index.js missing — run `bun run --filter ./packages/plugins/* typecheck` first",
      });
      continue;
    }
    try {
      const mod = (await import(`file://${distEntry}`)) as {
        default?: PluginDefinition<never>;
      };
      const def = mod.default;
      if (!def) {
        reports.push({ slug: entry, status: "failed", reason: "module has no default export" });
        continue;
      }
      const manifest = pluginManifest.parse({
        slug: def.slug,
        version: def.version,
        tier: def.tier,
        schema: def.schema,
        operations: Object.keys(def.operations),
        component: def.component
          ? { tag: def.component.tag, shadowMode: def.component.shadowMode ?? "open" }
          : undefined,
        hasStaticRender: Boolean(def.staticRender),
        ...(def.requestedCapabilities
          ? { requestedCapabilities: [...def.requestedCapabilities] }
          : {}),
        ...(def.workers ? { workers: [...def.workers] } : {}),
        ...(def.tools ? { tools: [...def.tools] } : {}),
      });
      const { signatureHex } = await signManifest({
        manifest,
        privateKeyHex: devKey.privateKeyHex,
      });
      writeFileSync(resolve(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(resolve(dir, "manifest.sig"), `${signatureHex}\n`);
      reports.push({ slug: def.slug, status: "signed" });
    } catch (e) {
      reports.push({ slug: entry, status: "failed", reason: (e as Error).message });
    }
  }
  return reports;
}

async function main(): Promise<void> {
  const forceNew = process.argv.includes("--new-key");
  const devKey = await loadOrCreateDevKey(forceNew);
  console.log(`Using public key ${devKey.publicKeyHex}`);
  const reports = await signAll(devKey);
  for (const r of reports) {
    const tag = r.status === "signed" ? "OK" : r.status === "skipped" ? "--" : "!!";
    console.log(`[${tag}] ${r.slug}${r.reason ? ` — ${r.reason}` : ""}`);
  }
  console.log(
    `\nNext: export CAELO_TIER1_PUBLIC_KEY=${devKey.publicKeyHex} so the loader verifies signatures.`,
  );
}

if (import.meta.main) {
  await main();
}
