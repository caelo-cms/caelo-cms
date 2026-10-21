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
 *
 * Issue #968: the seal also names the MCP client the grant was issued to
 * ({@link mcpClientKey}). The proxy forwards it to the admin, which keeps
 * one remote connection per (user, surface, client), so revoking one app
 * leaves the user's other apps working. A token from before #968 carries no
 * client and fails to open: the client refreshes (its refresh token names
 * the client) and carries on.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpSurface } from "./config.js";
import { type McpContext, resourceUrl } from "./context.js";
import { open, seal } from "./seal.js";

/** Longest client key; a longer CIMD URL or DCR name is hashed instead. */
export const MAX_CLIENT_KEY_LENGTH = 200;

/** Payload of a sealed access token. */
export const AccessSealSchema = z.strictObject({
  id_token: z.string(),
  /** The surface's resource URL, or null for a grant consented to for both surfaces. */
  resource: z.string().nullable(),
  /** The MCP client the grant was issued to ({@link mcpClientKey}). */
  client: z.string().min(1).max(MAX_CLIENT_KEY_LENGTH),
  exp: z.number().int(),
});

/**
 * The stable identity of an MCP client app, as the admin keys remote
 * connections by it:
 *
 * - CIMD: the `client_id` URL itself (`https://chatgpt.com/oauth/client.json`)
 *   — the vendor's one document for every user of that app;
 * - DCR: `dcr:<client_name>` — a DCR `client_id` is a fresh seal per
 *   registration, and clients such as Claude Code register again whenever
 *   they lose their cached registration, so the id would turn every
 *   re-registration into a new connection; the name stays the same;
 * - DCR without a name: `dcr:` + a hash of the registration, the only
 *   identity there is.
 *
 * The name is self-chosen, so the key identifies an app, not a person:
 * it never grants anything (IAP and the user's Caelo role do), it only
 * scopes revoke, restore and the cost cap to one app.
 *
 * @param clientName - the DCR registration's `client_name`, if any (unused for CIMD).
 */
export function mcpClientKey(clientId: string, clientName: string | null): string {
  const hashed = (v: string) =>
    `sha256:${createHash("sha256").update(v).digest("hex").slice(0, 32)}`;
  if (clientId.startsWith("https://")) {
    return clientId.length <= MAX_CLIENT_KEY_LENGTH ? clientId : hashed(clientId);
  }
  const name = clientName?.trim().replace(/\s+/g, " ");
  if (!name) return `dcr:${hashed(clientId)}`;
  const key = `dcr:${name}`;
  return key.length <= MAX_CLIENT_KEY_LENGTH ? key : `dcr:${hashed(name)}`;
}

/** Seal `idToken` for `resource` and `client`, expiring with it. */
export function sealAccessToken(
  ctx: McpContext,
  grant: { readonly idToken: string; readonly resource: string | null; readonly client: string },
  expiresIn: number,
): string {
  return seal(ctx.config.sealKey, "access", {
    id_token: grant.idToken,
    resource: grant.resource,
    client: grant.client,
    exp: ctx.nowSeconds() + expiresIn,
  });
}

/**
 * The Google ID token and client key inside `bearer`, when it is a
 * genuine, unexpired access token valid for `surface`; null otherwise (the
 * caller answers 401 `invalid_token`, which makes the client sign in again
 * for this resource, or refresh).
 */
export function openAccessToken(
  ctx: McpContext,
  bearer: string,
  surface: McpSurface,
): { readonly idToken: string; readonly client: string } | null {
  const opened = open(ctx.config.openKeys, "access", bearer, AccessSealSchema, ctx.nowSeconds());
  if (!opened.ok) return null;
  const { resource, id_token, client } = opened.value;
  if (resource !== null && resource !== resourceUrl(ctx.config, surface)) return null;
  return { idToken: id_token, client };
}
