// SPDX-License-Identifier: MPL-2.0

/**
 * #1340 (epic #763 E2-B) — a plugin as the gateway knows it: its manifest,
 * nothing else. No plugin code is imported, bundled or sandboxed here; the
 * definition this builds has no code operation at all. What a visitor can
 * reach is the manifest's declarations, which core runs
 * (public-run-host.ts, collections in apps/api-gateway).
 *
 * A release-signed plugin's manifest is the one in the image, verified
 * against the trust root (`manifest.json` + `manifest.sig`; the image
 * carries no dist). An installed plugin's manifest is the one the admin
 * published, bound to the Owner's approval by its artifact digest
 * (external-authorization.ts). This module imports nothing of the plugin
 * validator or the sandbox, so neither reaches the gateway's bundle.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { verifyManifestSignature } from "@caelo-cms/plugin-sandbox/manifest";
import {
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
  type PublicOperationDef,
  type PublicOperationManifest,
  pluginManifest,
  z,
} from "@caelo-cms/plugin-sdk";

/** A manifest's public operation as the definition dispatch enforces. */
export function publicOperationFromManifest(op: PublicOperationManifest): PublicOperationDef {
  return {
    name: op.name,
    kind: op.kind,
    captcha: op.captcha,
    // The visitor's body is validated against the reviewed JSON Schema.
    input: z.fromJSONSchema(op.inputJsonSchema),
    ...(op.rateLimit ? { rateLimit: op.rateLimit } : {}),
    reads: op.reads,
    writes: op.writes,
    // The declaration the host runs; no plugin code answers a visitor.
    run: op.run,
  };
}

/**
 * The definition of a plugin built from its manifest alone: the data the
 * gateway serves from (schema, table kinds, published admin columns,
 * public and collection operations, consent and mail declarations) and an
 * empty `operations`.
 */
export function declarativeDefinition(manifest: PluginManifest): PluginDefinition<PluginContext> {
  const m = manifest;
  return Object.freeze({
    slug: m.slug,
    version: m.version,
    tier: m.tier,
    schema: m.schema,
    ...(m.adminSchema ? { adminSchema: m.adminSchema } : {}),
    ...(m.indexes ? { indexes: m.indexes } : {}),
    ...(m.tableKinds ? { tableKinds: m.tableKinds } : {}),
    ...(m.visitorProjection ? { visitorProjection: m.visitorProjection } : {}),
    requestedCapabilities: m.requestedCapabilities,
    operations: Object.freeze({}),
    ...(m.publicOperations
      ? { publicOperations: m.publicOperations.map(publicOperationFromManifest) }
      : {}),
    ...(m.requires ? { requires: m.requires } : {}),
    ...(m.requiresPlugins ? { requiresPlugins: m.requiresPlugins } : {}),
    ...(m.consentPurposes ? { consentPurposes: m.consentPurposes } : {}),
    ...(m.consentProvider ? { consentProvider: m.consentProvider } : {}),
    ...(m.mailTemplates ? { mailTemplates: m.mailTemplates } : {}),
    ...(m.mailUnsubscribe ? { mailUnsubscribe: m.mailUnsubscribe } : {}),
    ...(m.collections ? { collections: m.collections } : {}),
    ...(m.collectionOperations ? { collectionOperations: m.collectionOperations } : {}),
  } as unknown as PluginDefinition<PluginContext>);
}

/**
 * Trust-root resolution (#387): explicit option → env override → the
 * `.tier1-trust-root` drop file the signer writes next to the plugins it
 * signed → the embedded release key inside verifyManifestSignature.
 */
export function resolveTrustRoot(opts: {
  readonly publicKeyHex?: string;
  readonly pluginsRoot: string;
}): string | undefined {
  const explicit = opts.publicKeyHex ?? process.env.CAELO_TIER1_PUBLIC_KEY;
  if (explicit) return explicit;
  try {
    return readFileSync(resolvePath(opts.pluginsRoot, ".tier1-trust-root"), "utf8").trim();
  } catch {
    // no drop file — the embedded release key is the trust root
    return undefined;
  }
}

/** The capabilities `requested` asks for beyond the Owner's `approved` set, sorted. */
export function unapprovedCapabilities(
  requested: readonly string[],
  approved: readonly string[] | null,
): string[] {
  const ok = new Set(approved ?? []);
  return [...new Set(requested)].filter((c) => !ok.has(c)).sort();
}

/**
 * A release-signed plugin's manifest from disk, its signature verified
 * against the trust root. Reads `manifest.json` and `manifest.sig` only:
 * no dist is imported (the gateway image carries none).
 */
export async function verifyDiskManifest(opts: {
  readonly pluginDir: string;
  readonly rawManifest: unknown;
  readonly publicKeyHex?: string;
}): Promise<PluginManifest> {
  const parsed = pluginManifest.safeParse(opts.rawManifest);
  if (!parsed.success) {
    throw new Error(`manifest invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const manifest = parsed.data;
  if (manifest.tier !== 1) {
    throw new Error("disk plugins must be tier 1; tier 2 plugins are submitted via plugins.submit");
  }
  let signatureHex: string;
  try {
    signatureHex = readFileSync(resolvePath(opts.pluginDir, "manifest.sig"), "utf8").trim();
  } catch {
    throw new Error("missing manifest.sig (Tier 1 requires a signed manifest)");
  }
  const sig = await verifyManifestSignature({
    manifest,
    signatureHex,
    publicKeyHex: opts.publicKeyHex,
  });
  if (!sig.ok) throw new Error(`signature verification failed: ${sig.reason}`);
  return manifest;
}

/** What {@link checkShippedManifests} found; `ok` is false when any manifest failed. */
export interface ShippedManifestsReport {
  readonly ok: boolean;
  readonly plugins: ReadonlyArray<{
    readonly slug: string;
    readonly ok: boolean;
    readonly reason?: string;
  }>;
}

/**
 * The gateway image's self-check (#1340): every shipped plugin's manifest
 * parses and its signature verifies against the image's trust root. The
 * image carries manifests, signatures and the trust root, nothing a plugin
 * runs; a plugin missing its signature fails the check.
 */
export async function checkShippedManifests(pluginsRoot: string): Promise<ShippedManifestsReport> {
  const { readdirSync, existsSync, statSync } = await import("node:fs");
  const publicKeyHex = resolveTrustRoot({ pluginsRoot });
  const plugins: { slug: string; ok: boolean; reason?: string }[] = [];
  for (const entry of readdirSync(pluginsRoot).sort()) {
    const pluginDir = resolvePath(pluginsRoot, entry);
    const manifestPath = resolvePath(pluginDir, "manifest.json");
    if (!statSync(pluginDir).isDirectory() || !existsSync(manifestPath)) continue;
    try {
      const rawManifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      const m = await verifyDiskManifest({
        pluginDir,
        rawManifest,
        ...(publicKeyHex ? { publicKeyHex } : {}),
      });
      plugins.push({ slug: m.slug, ok: true });
    } catch (e) {
      plugins.push({ slug: entry, ok: false, reason: (e as Error).message });
    }
  }
  return { ok: plugins.length > 0 && plugins.every((p) => p.ok), plugins };
}
