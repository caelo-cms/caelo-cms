// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-sandbox/manifest — manifest signature shape + verifier.
 *
 * Tier 1 plugins ship with an Ed25519 signature over the canonical JSON
 * of their manifest. The Caelo public key is embedded in this module
 * (rotated on major-version bumps). The host loader verifies the
 * signature on every startup AND on every re-enable.
 *
 * Tier 2 plugins do NOT carry a signature — the validator runs at
 * activation instead.
 *
 * Key generation lives in `scripts/sign-tier1-manifest.ts` (run by the
 * Caelo release process). For development + tests we use a fixed
 * test-only key pair below; the constant is replaced with the
 * production public key during release builds.
 */

import type { PluginManifest } from "@caelo-cms/plugin-sdk";

/**
 * Canonical JSON of a manifest. Stable byte order so signing +
 * verifying produce the same digest.
 */
export function canonicalManifestBytes(manifest: PluginManifest): Uint8Array {
  const canonical = JSON.stringify(manifest, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
  return new TextEncoder().encode(canonical);
}

/** Hex string ↔ Uint8Array helpers. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) {
    throw new Error("manifest: signature/key hex must be even-length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The current Caelo Tier-1 public key.
 *
 * Development + test placeholder. Replaced at release-build time.
 * The matching private key lives outside the repo; signing is done
 * by `scripts/sign-tier1-manifest.ts` against the release secret.
 */
export const CAELO_TIER1_PUBLIC_KEY_HEX =
  "30d77adfdc8c2c9e91a48bcab1c39ed4ee54d04e7e0c7b6c1c93cce1f8aacd9b";

let cachedPublicKey: CryptoKey | null = null;

async function getPublicKey(rawHex: string): Promise<CryptoKey> {
  if (cachedPublicKey) return cachedPublicKey;
  const raw = hexToBytes(rawHex);
  cachedPublicKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(raw),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return cachedPublicKey;
}

/** Coerce Uint8Array to a strict ArrayBuffer slice. WebCrypto's TS
 *  types in lib.dom.d.ts reject `Uint8Array<ArrayBufferLike>` when the
 *  underlying buffer might be a SharedArrayBuffer. Our buffers are
 *  always plain ArrayBuffer; this cast is type-only. */
function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Verify a Tier 1 manifest signature. Returns `{ ok: true }` on
 * verify; `{ ok: false, reason }` on mismatch / malformed input.
 *
 * The host loader treats `ok: false` as fatal for that plugin — it
 * refuses to load the plugin and inserts a `plugins` row with
 * status='failed' so the Owner sees the error in /security/plugins.
 */
export async function verifyManifestSignature(opts: {
  manifest: PluginManifest;
  signatureHex: string;
  publicKeyHex?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.manifest.tier !== 1) {
    return { ok: false, reason: "verifyManifestSignature called on a non-Tier-1 manifest" };
  }
  let signature: Uint8Array;
  try {
    signature = hexToBytes(opts.signatureHex);
  } catch (e) {
    return { ok: false, reason: `signature decode failed: ${(e as Error).message}` };
  }
  if (signature.length !== 64) {
    return { ok: false, reason: `signature length is ${signature.length}, expected 64 (Ed25519)` };
  }
  let publicKey: CryptoKey;
  try {
    publicKey = await getPublicKey(opts.publicKeyHex ?? CAELO_TIER1_PUBLIC_KEY_HEX);
  } catch (e) {
    return { ok: false, reason: `public key import failed: ${(e as Error).message}` };
  }
  const data = canonicalManifestBytes(opts.manifest);
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    asArrayBuffer(signature),
    asArrayBuffer(data),
  );
  return ok
    ? { ok: true }
    : { ok: false, reason: "signature did not verify against the embedded Caelo public key" };
}

/**
 * Sign a manifest with a private key. ONLY used by the release
 * tooling; never imported by the host. Exposed here so the test
 * suite can sign fixture manifests with a test key pair.
 */
export async function signManifest(opts: {
  manifest: PluginManifest;
  privateKeyHex: string;
}): Promise<{ signatureHex: string }> {
  const raw = hexToBytes(opts.privateKeyHex);
  // Ed25519 PKCS#8 wrapper: 0x302e020100300506032b657004220420 || 32-byte seed.
  const pkcs8Prefix = hexToBytes("302e020100300506032b657004220420");
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + raw.length);
  pkcs8.set(pkcs8Prefix, 0);
  pkcs8.set(raw, pkcs8Prefix.length);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    asArrayBuffer(pkcs8),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const data = canonicalManifestBytes(opts.manifest);
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, asArrayBuffer(data));
  return { signatureHex: bytesToHex(new Uint8Array(sigBuf)) };
}

/**
 * Generate a fresh Ed25519 key pair. ONLY used by the release tooling
 * + tests. Returns hex-encoded raw public/private bytes.
 */
export async function generateManifestKeyPair(): Promise<{
  publicKeyHex: string;
  privateKeyHex: string;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  // Strip the 16-byte PKCS#8 wrapper; the raw seed is the last 32 bytes.
  const privRaw = pkcs8.slice(pkcs8.length - 32);
  return { publicKeyHex: bytesToHex(pubRaw), privateKeyHex: bytesToHex(privRaw) };
}
