// SPDX-License-Identifier: MPL-2.0

/**
 * Cryptographically-strong opaque tokens for session cookies + CSRF.
 * 256 bits of entropy, URL-safe base64 (no padding).
 */

const TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToUrlBase64(bytes);
}

export function generateCsrfToken(): string {
  return generateSessionToken();
}

function bytesToUrlBase64(bytes: Uint8Array): string {
  // btoa wants a binary string. We slice into chunks to avoid call-stack limits
  // on large inputs, though 32 bytes never triggers that.
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Session lifetime: 7 days. Long enough to survive a workweek; short enough that a leaked cookie ages out quickly. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Password-reset link lifetime: 1 hour. Long enough to arrive by email and be
 * clicked; short enough that a leaked/forwarded link ages out fast.
 */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** A fresh, opaque password-reset token (same 256-bit URL-safe shape as sessions). */
export function generateResetToken(): string {
  return generateSessionToken();
}

/**
 * SHA-256 (hex) of a reset token. We persist ONLY this digest, never the raw
 * token — the raw value lives solely in the emailed link, so a DB read can't
 * reconstruct a working reset link. Redemption hashes the presented token and
 * compares against the stored digest.
 */
export function hashResetToken(rawToken: string): string {
  return new Bun.CryptoHasher("sha256").update(rawToken).digest("hex");
}
