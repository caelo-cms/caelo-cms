// SPDX-License-Identifier: MPL-2.0

/**
 * Per-form-render CSRF tokens via HMAC-SHA256. Pairs with a long-lived secret
 * stored on the session (the existing `sessions.csrf_token` column, treated
 * here as a secret rather than a token). The secret never leaves the server;
 * each form gets a fresh time-bound token derived from it.
 *
 * Token shape: `<timestampMs>.<nonceB64>.<hmacB64>` — all url-safe.
 */

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function urlBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

/** Generate a fresh form token from the session's csrf_secret. */
export async function signCsrfToken(secret: string): Promise<string> {
  const ts = Date.now();
  const nonceBytes = new Uint8Array(12);
  crypto.getRandomValues(nonceBytes);
  const nonce = urlBase64(nonceBytes);
  const message = `${ts}.${nonce}`;
  const sig = await hmacSha256(secret, message);
  return `${message}.${urlBase64(sig)}`;
}

/** Verify a form token against the session's csrf_secret. */
export async function verifyCsrfToken(secret: string, token: string): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [tsRaw, nonce, sigB64] = parts;
  if (!tsRaw || !nonce || !sigB64) return false;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > TOKEN_TTL_MS) return false;
  if (Date.now() - ts < -5_000) return false; // guard against clock skew abuse

  const expected = await hmacSha256(secret, `${tsRaw}.${nonce}`);
  const expectedB64 = urlBase64(expected);
  // Constant-time comparison — String.localeCompare returns 0 only on equal strings;
  // for security we prefer a length-checked byte compare.
  if (expectedB64.length !== sigB64.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expectedB64.length; i++) {
    mismatch |= expectedB64.charCodeAt(i) ^ sigB64.charCodeAt(i);
  }
  return mismatch === 0;
}
