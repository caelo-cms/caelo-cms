// SPDX-License-Identifier: MPL-2.0

/**
 * #387 regression guard — every shipped Tier-1 plugin's BUILT output must
 * pass the exact disk-load verification pipeline (manifest projection →
 * manifest validator → source validator over dist/index.js → Ed25519
 * sign + verify round-trip).
 *
 * This is the test that would have caught the two live defects the
 * gateway shipped with: `@caelo-cms/plugin-component-kit` missing from
 * the validator's import allowlist, and the SQL-keyword rule flagging
 * legitimate operation-name string literals ("comment_archive.insert") —
 * together those marked 5/6 plugins `failed` on every gateway boot.
 *
 * No DB required: the pipeline pieces under test are pure. The dists are
 * built by `tsc -b` (CI runs it before tests; the root tsconfig
 * references every shipped plugin), so a missing dist is a broken build,
 * not a skippable condition (no-fallbacks).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  generateManifestKeyPair,
  signManifest,
  validateManifest,
  validateSource,
  verifyManifestSignature,
} from "@caelo-cms/plugin-sandbox";
import { manifestFromDefinition, type PluginDefinition } from "@caelo-cms/plugin-sdk";

const PLUGINS_ROOT = resolve(import.meta.dir, "../../plugins");

function shippedPluginDirs(): string[] {
  return readdirSync(PLUGINS_ROOT)
    .map((entry) => resolve(PLUGINS_ROOT, entry))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory() && existsSync(resolve(dir, "package.json"));
      } catch {
        return false;
      }
    });
}

describe("#387 — shipped plugins pass the disk-load pipeline", () => {
  const dirs = shippedPluginDirs();

  it("finds the shipped plugin set", () => {
    // If this shrinks unexpectedly a plugin dir was moved/renamed — the
    // per-plugin tests below silently disappearing would mask a break.
    expect(dirs.length).toBeGreaterThanOrEqual(5);
  });

  for (const dir of dirs) {
    const slug = dir.split("/").at(-1) ?? dir;
    it(`${slug}: dist builds, validates, signs and verifies`, async () => {
      const distPath = resolve(dir, "dist", "index.js");
      expect(existsSync(distPath)).toBe(true);

      const mod = (await import(`file://${distPath}`)) as {
        default?: PluginDefinition<never>;
      };
      expect(mod.default).toBeDefined();
      const def = mod.default;
      if (!def) throw new Error("unreachable");

      // 1. Manifest projection + validator.
      const manifest = manifestFromDefinition(def);
      const manifestCheck = validateManifest(manifest);
      expect(manifestCheck.failures).toEqual([]);

      // 2. Source validator over the exact artifact the loader imports.
      const source = readFileSync(distPath, "utf8");
      const sourceFailures = validateSource({ filename: `${slug}/dist/index.js`, source });
      expect(sourceFailures).toEqual([]);

      // 3. Signature round-trip — the same sign/verify pair the release
      // tooling and the loader use.
      const pair = await generateManifestKeyPair();
      const { signatureHex } = await signManifest({
        manifest,
        privateKeyHex: pair.privateKeyHex,
      });
      const verified = await verifyManifestSignature({
        manifest,
        signatureHex,
        publicKeyHex: pair.publicKeyHex,
      });
      expect(verified).toEqual({ ok: true });
    });
  }
});
