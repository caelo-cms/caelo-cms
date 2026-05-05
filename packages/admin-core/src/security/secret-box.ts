// SPDX-License-Identifier: MPL-2.0

/**
 * AES-256-GCM "secret box" — at-rest encryption for sensitive values
 * stored in cms_admin (currently: AI provider API keys; later:
 * arbitrary plugin-supplied OAuth client secrets, SMTP passwords, etc).
 *
 * Threat model + key choices:
 *   - The KEK lives in `process.env.CAELO_SECRET_KEK` (32 hex bytes).
 *     On cloud installs the value is mounted from Secret Manager into
 *     Cloud Run's env. On Compose installs it's written into the
 *     generated `.env`. On dev it's auto-generated + persisted to
 *     `.caelo/dev-kek` on first run (see hooks.server.ts).
 *   - Each row carries its own random 12-byte IV alongside the
 *     ciphertext (`api_key_iv`).
 *   - Each row also carries a `kek_fp` (first 8 hex of SHA-256(KEK))
 *     so a future rotation tool can detect rows still encrypted under
 *     the old KEK and refuse to silently return garbage.
 *
 * Web Crypto only — no `node:crypto`. Same primitives the plugin-sandbox
 * + auth plugin use, works under any modern runtime.
 */

const KEK_ENV = "CAELO_SECRET_KEK";
const ALGO = "AES-GCM" as const;
const KEK_BYTES = 32;
const IV_BYTES = 12;

let cachedKey: CryptoKey | null = null;
let cachedFingerprint: string | null = null;
let testKekOverride: Uint8Array | null = null;

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error("KEK must be hex-encoded");
  if (hex.length !== KEK_BYTES * 2) {
    throw new Error(
      `KEK must decode to ${KEK_BYTES} bytes (${KEK_BYTES * 2} hex chars), got ${hex.length}`,
    );
  }
  const out = new Uint8Array(KEK_BYTES);
  for (let i = 0; i < KEK_BYTES; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function loadKekBytes(): Uint8Array {
  if (testKekOverride) return testKekOverride;
  const raw = process.env[KEK_ENV];
  if (!raw) {
    throw new Error(
      `${KEK_ENV} is not set. On production installs this is provisioned via Secret Manager; ` +
        `on dev it should auto-generate to .caelo/dev-kek (see apps/admin/src/hooks.server.ts).`,
    );
  }
  return hexToBytes(raw);
}

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const bytes = loadKekBytes();
  cachedKey = await crypto.subtle.importKey("raw", bytes as BufferSource, ALGO, false, [
    "encrypt",
    "decrypt",
  ]);
  return cachedKey;
}

/** First 8 hex of SHA-256(KEK). Stamped on each encrypted row. */
export async function kekFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint;
  const bytes = loadKekBytes();
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  cachedFingerprint = bytesToHex(new Uint8Array(hash)).slice(0, 8);
  return cachedFingerprint;
}

export interface EncryptedSecret {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly kekFingerprint: string;
}

/** Encrypt a UTF-8 string under the project KEK. Each call uses a fresh random IV. */
export async function encryptSecret(plaintext: string): Promise<EncryptedSecret> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: ALGO, iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  return { ciphertext, iv, kekFingerprint: await kekFingerprint() };
}

/**
 * Decrypt a row written by `encryptSecret`. Throws if the KEK fingerprint
 * doesn't match (stale ciphertext from a rotated KEK) so callers get a
 * loud failure rather than garbage.
 */
export async function decryptSecret(args: EncryptedSecret): Promise<string> {
  const fp = await kekFingerprint();
  if (args.kekFingerprint !== fp) {
    throw new Error(
      `secret was encrypted under a different KEK (row fp=${args.kekFingerprint}, current fp=${fp}). Rotate via the (forthcoming) re-encrypt CLI.`,
    );
  }
  const key = await getKey();
  const plain = await crypto.subtle.decrypt(
    { name: ALGO, iv: args.iv as BufferSource },
    key,
    args.ciphertext as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** Test-only: inject a deterministic KEK without touching env or the dev file. */
export function _setKekForTests(bytes: Uint8Array | null): void {
  if (bytes !== null && bytes.length !== KEK_BYTES) {
    throw new Error(`test KEK must be ${KEK_BYTES} bytes`);
  }
  testKekOverride = bytes;
  cachedKey = null;
  cachedFingerprint = null;
}

/**
 * Helper for the dev-mode auto-gen path (hooks.server.ts). Generates a
 * fresh KEK as a hex string. Persistence + env-export is the caller's job.
 */
export function generateKekHex(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(KEK_BYTES)));
}
