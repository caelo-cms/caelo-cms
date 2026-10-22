// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #946 — the read-only credential an opaque-origin preview uses to
 * load the admin's media (`/_caelo/media/*`).
 *
 * The editor's preview iframes are sandboxed WITHOUT `allow-same-origin`,
 * so the previewed page (whose module scripts are untrusted) runs in an
 * opaque origin. Its subresource requests are cross-site from the
 * browser's point of view, so the `SameSite=Lax` session cookie is not sent
 * — which is the point: a script in the preview must not act as the
 * operator. Images still have to load, so every preview response sets this
 * grant next to the page:
 *
 * - `SameSite=None; Secure; HttpOnly; Path=/_caelo/` — sent with the
 *   preview's image requests, invisible to its scripts, and only to the
 *   `/_caelo/` asset routes.
 * - The value is an HMAC-signed `{user, expiry}` pair (key derived from the
 *   KEK, so every admin instance verifies it). It grants exactly what the
 *   asset routes serve: content-addressed media bytes any logged-in user
 *   may read. It never authenticates any other route.
 * - Expiry is hours, re-minted on every preview load; logout clears it. A
 *   script in the preview can make the browser SEND it (an `<img>`), never
 *   read a response with it (CORS), so it adds no read capability.
 *
 * Fonts do not use the grant: font loads are CORS requests, which an
 * opaque origin makes without credentials, so the preview inlines them
 * (see `preview-sandbox.ts`).
 */

import { deriveKekSubkey } from "@caelo-cms/admin-core";
import type { Cookies } from "@sveltejs/kit";

/** Cookie name; distinct from the session so no other route ever reads it. */
export const PREVIEW_ASSET_GRANT_COOKIE = "caelo_preview_assets";

/** The only path the browser sends the grant to. */
export const PREVIEW_ASSET_GRANT_PATH = "/_caelo/";

/** Lifetime of one grant; every preview load re-mints it. */
export const PREVIEW_ASSET_GRANT_TTL_MS = 2 * 60 * 60 * 1000;

const VERSION = "v1";
const KEY_LABEL = "caelo/preview-asset-grant/v1";

interface GrantPayload {
  /** User the grant was minted for (audit context only). */
  readonly u: string;
  /** Expiry, epoch ms. */
  readonly e: number;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    "base64url",
  );
}

/**
 * Mint a grant for `userId`. `now` is injectable for expiry tests only.
 */
export async function mintPreviewAssetGrant(userId: string, now = Date.now()): Promise<string> {
  const payload: GrantPayload = { u: userId, e: now + PREVIEW_ASSET_GRANT_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const key = await deriveKekSubkey(KEY_LABEL);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${VERSION}.${payloadB64}.${b64url(sig)}`;
}

export type PreviewAssetGrantVerification =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: "malformed" | "bad-signature" | "expired" };

/**
 * Verify a grant's signature and expiry (constant-time: WebCrypto
 * `verify`). The reason is log-safe; it never echoes token material.
 */
export async function verifyPreviewAssetGrant(
  token: string,
  now = Date.now(),
): Promise<PreviewAssetGrantVerification> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }
  const [, payloadB64, sigB64] = parts as [string, string, string];
  const key = await deriveKekSubkey(KEY_LABEL);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    Buffer.from(sigB64, "base64url"),
    new TextEncoder().encode(payloadB64),
  );
  if (!valid) return { ok: false, reason: "bad-signature" };
  let payload: GrantPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as GrantPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.u !== "string" || typeof payload.e !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (now >= payload.e) return { ok: false, reason: "expired" };
  return { ok: true, userId: payload.u };
}

/**
 * Set (or refresh) the grant on a preview response for the logged-in
 * `userId`.
 */
export async function setPreviewAssetGrant(cookies: Cookies, userId: string): Promise<void> {
  cookies.set(PREVIEW_ASSET_GRANT_COOKIE, await mintPreviewAssetGrant(userId), {
    path: PREVIEW_ASSET_GRANT_PATH,
    httpOnly: true,
    // `None` is what lets the opaque-origin preview's image requests carry
    // it; `None` requires `Secure` (browsers treat http://localhost as
    // secure, so dev and the E2E stack work too).
    sameSite: "none",
    secure: true,
    maxAge: Math.floor(PREVIEW_ASSET_GRANT_TTL_MS / 1000),
  });
}

/** Drop the grant (logout). */
export function clearPreviewAssetGrant(cookies: Cookies): void {
  cookies.delete(PREVIEW_ASSET_GRANT_COOKIE, {
    path: PREVIEW_ASSET_GRANT_PATH,
    sameSite: "none",
    secure: true,
  });
}
