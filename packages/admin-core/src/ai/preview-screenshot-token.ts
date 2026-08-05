// SPDX-License-Identifier: MPL-2.0

/**
 * issue #412 — short-lived, signed, branch-scoped tokens for the
 * server-side `screenshot_page` backend (implementation decision (1),
 * recorded on the issue).
 *
 * The headless Chromium that captures a branch preview has no operator
 * session, so it authenticates each request with one of these tokens
 * instead: `mintPreviewScreenshotToken` is called by the in-process
 * capture service immediately before navigation, and the admin's
 * preview-screenshot + asset routes call `verifyPreviewScreenshotToken`.
 *
 * Security shape (keep all four when touching this file):
 * - HMAC-SHA256 over the payload, constant-time compare.
 * - Expiry is minutes, not hours — a token is minted per capture and is
 *   worthless shortly after.
 * - Scope is baked into the signed payload: pageId + chatBranchId. The
 *   document route binds on pageId, so a token minted for one page
 *   cannot open another; the branch comes from the payload (never a
 *   query param), so it cannot be tampered either.
 * - The secret is per-process and ephemeral (generated at first use,
 *   never persisted, never logged). Mint and verify happen in the SAME
 *   admin process — the browser navigates to 127.0.0.1 of the server
 *   that minted the token — so no cross-process key distribution is
 *   needed, and a leaked DB/backup cannot leak the key.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Header the capture service sends on EVERY browser request (navigation +
 *  subresources), and the asset routes accept as a session alternative. */
export const PREVIEW_SCREENSHOT_TOKEN_HEADER = "x-caelo-preview-screenshot-token";

/** Token lifetime. Long enough for navigation + network settle + capture,
 *  short enough that an exfiltrated token is stale by the time it travels. */
export const PREVIEW_SCREENSHOT_TOKEN_TTL_MS = 2 * 60 * 1000;

const VERSION = "v1";

let processSecret: Buffer | null = null;

function secret(): Buffer {
  if (!processSecret) processSecret = randomBytes(32);
  return processSecret;
}

/** Test seam — install a known secret (or null to restore the ephemeral
 *  per-process one). Lets adversarial tests sign with a DIFFERENT key. */
export function setPreviewScreenshotSecretForTests(next: Buffer | null): void {
  processSecret = next;
}

interface TokenPayload {
  /** Page the token is bound to. */
  readonly p: string;
  /** Chat branch whose staged state the render overlays; null = published. */
  readonly b: string | null;
  /** Expiry, epoch ms. */
  readonly e: number;
}

function sign(payloadB64: string, key: Buffer): string {
  return createHmac("sha256", key).update(payloadB64).digest("base64url");
}

/**
 * Mint a token for one capture of `pageId` (optionally overlaying
 * `chatBranchId`). `now` is injectable for expiry tests only.
 */
export function mintPreviewScreenshotToken(args: {
  readonly pageId: string;
  readonly chatBranchId?: string;
  readonly now?: number;
}): string {
  const payload: TokenPayload = {
    p: args.pageId,
    b: args.chatBranchId ?? null,
    e: (args.now ?? Date.now()) + PREVIEW_SCREENSHOT_TOKEN_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${VERSION}.${payloadB64}.${sign(payloadB64, secret())}`;
}

export type PreviewScreenshotTokenVerification =
  | { readonly ok: true; readonly pageId: string; readonly chatBranchId: string | null }
  | {
      readonly ok: false;
      /** Stable, log-safe reason — never echoes token material. */
      readonly reason: "malformed" | "bad-signature" | "expired" | "page-mismatch";
    };

/**
 * Verify signature + expiry, and — when `expectedPageId` is given (the
 * document route) — that the token was minted for THAT page. Asset routes
 * omit `expectedPageId`: media/font bytes are not page-scoped and any
 * live capture token may load them, exactly like any logged-in session.
 */
export function verifyPreviewScreenshotToken(
  token: string,
  opts?: { readonly expectedPageId?: string; readonly now?: number },
): PreviewScreenshotTokenVerification {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }
  const [, payloadB64, sigB64] = parts as [string, string, string];
  const expected = Buffer.from(sign(payloadB64, secret()), "utf8");
  const provided = Buffer.from(sigB64, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "bad-signature" };
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.p !== "string" ||
    typeof payload.e !== "number" ||
    (payload.b !== null && typeof payload.b !== "string")
  ) {
    return { ok: false, reason: "malformed" };
  }
  if ((opts?.now ?? Date.now()) >= payload.e) {
    return { ok: false, reason: "expired" };
  }
  if (opts?.expectedPageId !== undefined && payload.p !== opts.expectedPageId) {
    return { ok: false, reason: "page-mismatch" };
  }
  return { ok: true, pageId: payload.p, chatBranchId: payload.b };
}
