// SPDX-License-Identifier: MPL-2.0

/**
 * The access token the broker hands an MCP client (issue #806 follow-up):
 * the user's Google ID token sealed together with the MCP surface the
 * grant was authorized for (RFC 8707 resource).
 *
 * Why not the raw ID token: a Google ID token carries no resource, so a
 * client the user approved for the chat surface could send it to the
 * admin surface and IAP would let it through — the consent page's "gets
 * access to: chat" would be a promise nothing enforces. Sealed, the proxy
 * can check the surface on every request and forward only the inner ID
 * token, which IAP then checks as before. A grant whose client never named
 * a resource was consented to as "chat and admin tools" and opens both.
 *
 * Side effect, intended: the bearer in the client's hands is useless
 * against IAP directly or against any other Google API; it only works
 * through this broker, under this install's seal key.
 */

import { z } from "zod";
import type { McpSurface } from "./config.js";
import { type McpContext, resourceUrl } from "./context.js";
import { open, seal } from "./seal.js";

/** Payload of a sealed access token. */
export const AccessSealSchema = z.strictObject({
  id_token: z.string(),
  /** The surface's resource URL, or null for a grant consented to for both surfaces. */
  resource: z.string().nullable(),
  exp: z.number().int(),
});

/** Seal `idToken` for `resource`, expiring with it. */
export function sealAccessToken(
  ctx: McpContext,
  idToken: string,
  resource: string | null,
  expiresIn: number,
): string {
  return seal(ctx.config.sealKey, "access", {
    id_token: idToken,
    resource,
    exp: ctx.nowSeconds() + expiresIn,
  });
}

/**
 * The Google ID token inside `bearer`, when it is a genuine, unexpired
 * access token valid for `surface`; null otherwise (the caller answers
 * 401 `invalid_token`, which makes the client sign in again for this
 * resource).
 */
export function openAccessToken(
  ctx: McpContext,
  bearer: string,
  surface: McpSurface,
): string | null {
  const opened = open(ctx.config.openKeys, "access", bearer, AccessSealSchema, ctx.nowSeconds());
  if (!opened.ok) return null;
  const { resource, id_token } = opened.value;
  if (resource !== null && resource !== resourceUrl(ctx.config, surface)) return null;
  return id_token;
}
