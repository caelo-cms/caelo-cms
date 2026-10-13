// SPDX-License-Identifier: MPL-2.0

/**
 * The CLI's side of the admin's /api/internal/* token
 * (apps/admin/src/lib/server/internal-jwt.ts): HMAC-SHA256 over
 * `"<iat>:<exp>:<scope>"` with the install's internal secret, valid for the
 * admin's 5-minute replay window. One token per call.
 */

/** Replay window the admin enforces; tokens never outlive it. */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Mint a token for `scope`.
 *
 * @param secret - the install's internal secret (≥32 chars; Secret Manager
 *   `<prefix>-internal-secret` on cloud installs, never written to disk).
 * @param now - ms since epoch; tests pin it.
 */
export async function mintInternalToken(
  secret: string,
  scope: string,
  now: number = Date.now(),
): Promise<string> {
  const message = `${now}:${now + TOKEN_TTL_MS}:${scope}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return `${Buffer.from(message).toString("base64url")}.${Buffer.from(sig).toString("base64url")}`;
}
