// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/dev-signing — boot-time dev auto-signer.
 *
 * Issue #387 closed the "one trust path" gap: signature verification +
 * validator now run in EVERY mode — there is no unverified plugin load
 * anymore. The dev convenience that replaces the old skip is this
 * module: on a non-production host, before bootstrap walks the plugin
 * dirs, each plugin's `manifest.json`/`manifest.sig` is (re)generated
 * from its built `dist/index.js` with the repo-local `.caelo-dev-key`
 * whenever the artifacts are missing or stale. The loader then verifies
 * against the dev public key exactly like production verifies against
 * the release key — same code path, different trust root.
 *
 * Release builds never call this: their manifests are signed by CI
 * (`release-cut.yml`) with the production key whose public half is
 * embedded in plugin-sandbox/manifest.ts.
 *
 * The signed manifest is a projection of the built definition
 * (`manifestFromDefinition`), so signing is idempotent: when the stored
 * manifest.json equals the freshly derived one AND the signature
 * verifies against the dev key, the plugin dir is left untouched.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  canonicalManifestBytes,
  generateManifestKeyPair,
  signManifest,
  verifyManifestSignature,
} from "@caelo-cms/plugin-sandbox";
import { manifestFromDefinition, type PluginDefinition } from "@caelo-cms/plugin-sdk";

export interface DevKeyPair {
  readonly publicKeyHex: string;
  readonly privateKeyHex: string;
}

/**
 * Trust-root drop file written next to the signed plugins. The loader
 * falls back to it when neither `publicKeyHex` nor the env override is
 * set, so a dev checkout AND a container image are self-contained: the
 * key that signed the in-tree manifests travels with them. Image
 * provenance (was this filesystem produced by Caelo CI?) is cosign's
 * job at the registry layer, not this file's.
 */
export const TRUST_ROOT_FILENAME = ".tier1-trust-root";

/**
 * Load the dev key pair from `keyPath`, generating + persisting a fresh
 * one when the file is absent (or `forceNew`). The file is gitignored.
 */
export async function loadOrCreateDevKey(opts: {
  keyPath: string;
  forceNew?: boolean;
}): Promise<DevKeyPair> {
  if (!opts.forceNew && existsSync(opts.keyPath)) {
    const raw = JSON.parse(readFileSync(opts.keyPath, "utf8")) as DevKeyPair;
    if (!raw.publicKeyHex || !raw.privateKeyHex) {
      throw new Error(`dev key file ${opts.keyPath} is malformed — delete it to regenerate`);
    }
    return raw;
  }
  const pair = await generateManifestKeyPair();
  writeFileSync(opts.keyPath, `${JSON.stringify(pair, null, 2)}\n`);
  return pair;
}

export interface DevSignReport {
  readonly slug: string;
  readonly status: "signed" | "fresh" | "skipped" | "failed";
  readonly reason?: string;
}

/**
 * Walk `pluginsRoot` and ensure every buildable plugin dir carries a
 * dev-signed `manifest.json` + `manifest.sig` matching its current
 * `dist/index.js`. Returns the dev public key hex the caller passes to
 * `bootstrap({ publicKeyHex })` so verification uses the matching root.
 */
export async function ensureDevSignedManifests(opts: {
  pluginsRoot: string;
  keyPath: string;
  /** Explicit key pair (release/CI signing) — skips the keyPath file. */
  key?: DevKeyPair;
}): Promise<{ publicKeyHex: string; reports: DevSignReport[] }> {
  const devKey = opts.key ?? (await loadOrCreateDevKey({ keyPath: opts.keyPath }));
  const reports: DevSignReport[] = [];

  let entries: string[] = [];
  try {
    entries = readdirSync(opts.pluginsRoot);
  } catch {
    return { publicKeyHex: devKey.publicKeyHex, reports };
  }

  for (const entry of entries) {
    const dir = resolvePath(opts.pluginsRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const distEntry = resolvePath(dir, "dist", "index.js");
    if (!existsSync(distEntry)) {
      reports.push({
        slug: entry,
        status: "skipped",
        reason: "dist/index.js missing — build the plugin (tsc -b) before boot",
      });
      continue;
    }
    try {
      const mod = (await import(`file://${distEntry}`)) as {
        default?: PluginDefinition<never>;
      };
      if (!mod.default) {
        reports.push({ slug: entry, status: "failed", reason: "module has no default export" });
        continue;
      }
      const manifest = manifestFromDefinition(mod.default);

      // Freshness: identical canonical manifest + verifying signature ⇒ no-op.
      const manifestPath = resolvePath(dir, "manifest.json");
      const sigPath = resolvePath(dir, "manifest.sig");
      if (existsSync(manifestPath) && existsSync(sigPath)) {
        try {
          const stored = JSON.parse(readFileSync(manifestPath, "utf8")) as Parameters<
            typeof canonicalManifestBytes
          >[0];
          const same =
            Buffer.compare(
              Buffer.from(canonicalManifestBytes(stored)),
              Buffer.from(canonicalManifestBytes(manifest)),
            ) === 0;
          if (same) {
            const sig = await verifyManifestSignature({
              manifest,
              signatureHex: readFileSync(sigPath, "utf8").trim(),
              publicKeyHex: devKey.publicKeyHex,
            });
            if (sig.ok) {
              reports.push({ slug: manifest.slug, status: "fresh" });
              continue;
            }
          }
        } catch {
          // fall through to re-sign — a corrupt stored manifest is stale by definition
        }
      }

      const { signatureHex } = await signManifest({
        manifest,
        privateKeyHex: devKey.privateKeyHex,
      });
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(sigPath, `${signatureHex}\n`);
      reports.push({ slug: manifest.slug, status: "signed" });
    } catch (e) {
      reports.push({ slug: entry, status: "failed", reason: (e as Error).message });
    }
  }

  writeFileSync(resolvePath(opts.pluginsRoot, TRUST_ROOT_FILENAME), `${devKey.publicKeyHex}\n`);

  return { publicKeyHex: devKey.publicKeyHex, reports };
}
