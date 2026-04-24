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
