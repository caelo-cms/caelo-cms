// SPDX-License-Identifier: MPL-2.0

/**
 * Read guard for the asset routes a preview pulls in (`/_caelo/media/...`,
 * `/_caelo/fonts/...`). Three credentials are accepted, in order:
 *
 * 1. The operator's session (the admin UI itself, e.g. the media library).
 * 2. issue #412 — the server-side `screenshot_page` backend renders the
 *    preview in a headless Chromium that has NO session cookie; it sends
 *    the short-lived signed capture token (minted in the same process) as
 *    a header on every same-origin request instead.
 * 3. issue #946 — the editor's preview iframes run in an OPAQUE origin, so
 *    the Lax session cookie is not sent with their image requests; the
 *    preview response sets a signed, read-only grant cookie for exactly
 *    these routes (`preview-asset-grant.ts`).
 *
 * These routes serve content-addressed bytes any logged-in user may read,
 * so honouring a live token or grant grants nothing a session would not.
 */

import {
  PREVIEW_SCREENSHOT_TOKEN_HEADER,
  verifyPreviewScreenshotToken,
} from "@caelo-cms/admin-core";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type Cookies, error, redirect } from "@sveltejs/kit";
import { PREVIEW_ASSET_GRANT_COOKIE, verifyPreviewAssetGrant } from "./preview-asset-grant.js";

/** Same fixed system actor the admin's other system-dispatched shells use
 *  (hooks.server.ts, /api/mcp/*). */
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

function systemCtx(): ExecutionContext {
  return { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: crypto.randomUUID() };
}

/**
 * Returns the ExecutionContext to run the route's reads under: the
 * session user's ctx when logged in, a system ctx when a valid preview
 * capture token or preview asset grant is presented, otherwise the same
 * redirect/401 the plain `requireUser` guard would produce.
 */
export async function requirePreviewAssetAccess(
  locals: App.Locals,
  request: Request,
  cookies: Cookies,
): Promise<ExecutionContext> {
  if (locals.user) return locals.ctx;
  const token = request.headers.get(PREVIEW_SCREENSHOT_TOKEN_HEADER);
  if (token !== null) {
    const v = verifyPreviewScreenshotToken(token);
    if (v.ok) return systemCtx();
    // Reason only — never echo token material into the response/logs.
    throw error(401, `invalid preview screenshot token (${v.reason})`);
  }
  const grant = cookies.get(PREVIEW_ASSET_GRANT_COOKIE);
  if (grant !== undefined) {
    const v = await verifyPreviewAssetGrant(grant);
    if (v.ok) return systemCtx();
    throw error(401, `invalid preview asset grant (${v.reason}); reload the preview`);
  }
  throw redirect(303, "/login");
}
