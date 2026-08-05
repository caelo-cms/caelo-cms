// SPDX-License-Identifier: MPL-2.0

/**
 * issue #412 — session-or-token guard for the asset routes the branch
 * preview pulls in (`/_caelo/media/...`, `/_caelo/fonts/...`).
 *
 * The server-side `screenshot_page` backend renders the preview in a
 * headless Chromium that has NO session cookie; it sends the short-lived
 * signed capture token (minted in the same process) as a header on every
 * request instead. These routes serve content-addressed bytes any
 * logged-in user may read, so honouring a live capture token grants
 * nothing a session would not — and the token's minutes-long expiry keeps
 * the grant as ephemeral as the capture.
 */

import {
  PREVIEW_SCREENSHOT_TOKEN_HEADER,
  verifyPreviewScreenshotToken,
} from "@caelo-cms/admin-core";
import type { ExecutionContext } from "@caelo-cms/shared";
import { error, redirect } from "@sveltejs/kit";

/** Same fixed system actor the admin's other system-dispatched shells use
 *  (hooks.server.ts, /api/mcp/*). */
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

/**
 * Returns the ExecutionContext to run the route's reads under: the
 * session user's ctx when logged in, a system ctx when a valid preview
 * capture token is presented, otherwise the same redirect/401 the plain
 * `requireUser` guard would produce.
 */
export function requireUserOrPreviewScreenshotToken(
  locals: App.Locals,
  request: Request,
): ExecutionContext {
  if (locals.user) return locals.ctx;
  const token = request.headers.get(PREVIEW_SCREENSHOT_TOKEN_HEADER);
  if (token !== null) {
    const v = verifyPreviewScreenshotToken(token);
    if (v.ok) {
      return {
        actorId: SYSTEM_ACTOR_ID,
        actorKind: "system",
        requestId: crypto.randomUUID(),
      };
    }
    // Reason only — never echo token material into the response/logs.
    throw error(401, `invalid preview screenshot token (${v.reason})`);
  }
  throw redirect(303, "/login");
}
