// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — HMAC-signed gateway cookies.
 *
 * Both `caelo_visitor_id` and `caelo_session` carry a server-side secret
 * signature so a hostile sister-subdomain or a compromised first-party
 * script can't forge a cookie value (e.g. impersonate another visitor's
 * rate-limit bucket or replay a session token from a different user).
 *
 * Format:
 *   <value>.<issued_at_seconds>.<signature_hex>
 *
 * Signature = HMAC-SHA256(secret, `${value}.${issued_at}`).
 *
 * Verification rejects:
 *   - missing/extra parts
 *   - issued_at older than 30 days (visitor) / past expiry (session)
 *   - HMAC mismatch (timing-safe compare)
 */

const TEXT_ENCODER = new TextEncoder();

export interface SignedCookie {
  readonly value: string;
  readonly issuedAt: number;
}

let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function importHmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  cachedKey = { secret, key };
  return key;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const n = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(n)) return null;
    out[i] = n;
  }
  return out;
}

export async function signCookieValue(args: {
  value: string;
  secret: string;
  issuedAt?: number;
}): Promise<string> {
  const issuedAt = args.issuedAt ?? Math.floor(Date.now() / 1000);
  const key = await importHmacKey(args.secret);
  const payload = `${args.value}.${issuedAt}`;
  const sig = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(payload));
  return `${payload}.${bytesToHex(new Uint8Array(sig))}`;
}

/**
 * Verify a signed cookie. Returns the original value + issued_at on
 * success; null on any failure (parser, HMAC mismatch, expiry).
 */
export async function verifySignedCookie(args: {
  signed: string;
  secret: string;
  /** Reject if `issued_at` is older than this many seconds (visitor: 30d). */
  maxAgeSeconds?: number;
}): Promise<SignedCookie | null> {
  const parts = args.signed.split(".");
  if (parts.length !== 3) return null;
  const [value, issuedAtStr, sigHex] = parts;
  if (!value || !issuedAtStr || !sigHex) return null;
  const issuedAt = Number.parseInt(issuedAtStr, 10);
  if (!Number.isFinite(issuedAt)) return null;
  if (args.maxAgeSeconds !== undefined) {
    const ageSec = Math.floor(Date.now() / 1000) - issuedAt;
    if (ageSec > args.maxAgeSeconds || ageSec < -60) return null;
  }
  const sigBytes = hexToBytes(sigHex);
  if (sigBytes?.length !== 32) return null;
  const key = await importHmacKey(args.secret);
  const payload = `${value}.${issuedAt}`;
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes.buffer.slice(
      sigBytes.byteOffset,
      sigBytes.byteOffset + sigBytes.byteLength,
    ) as ArrayBuffer,
    TEXT_ENCODER.encode(payload),
  );
  if (!ok) return null;
  return { value, issuedAt };
}

/** Generate a fresh 64-byte secret for HMAC. */
export function generateCookieSecret(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
