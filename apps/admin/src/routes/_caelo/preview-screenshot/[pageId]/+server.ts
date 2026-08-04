// SPDX-License-Identifier: MPL-2.0

/**
 * issue #412 — token-authenticated branch preview for the server-side
 * `screenshot_page` backend.
 *
 * GET `/_caelo/preview-screenshot/[pageId]` returns the SAME composed
 * HTML the operator's `/edit/preview/[pageId]?branch=…` iframe shows —
 * minus the live-edit inject script, which a screenshot must not show —
 * authenticated by a short-lived signed token instead of a session
 * cookie (the capturing headless Chromium has none).
 *
 * Scope enforcement happens in the token, not in query params: the
 * signed payload carries pageId + chatBranchId, verification binds the
 * payload's pageId to the route param, and the branch is read from the
 * payload — so neither can be tampered without breaking the signature.
 * The token normally arrives as a header (the capture service sends it
 * on every request); `?token=` is accepted for the document navigation
 * so agent-driven browser tooling can open a preview from a plain URL.
 */

import {
  PREVIEW_SCREENSHOT_TOKEN_HEADER,
  verifyPreviewScreenshotToken,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { error } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

/** Same fixed system actor as hooks.server.ts and the /api/mcp shells. */
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

export const GET: RequestHandler = async ({ params, request, url }) => {
  const token =
    request.headers.get(PREVIEW_SCREENSHOT_TOKEN_HEADER) ?? url.searchParams.get("token");
  if (!token) throw error(401, "missing preview screenshot token");
  const v = verifyPreviewScreenshotToken(token, { expectedPageId: params.pageId });
  // Reason only — never echo token material into the response/logs.
  if (!v.ok) throw error(401, `invalid preview screenshot token (${v.reason})`);

  const systemCtx: ExecutionContext = {
    actorId: SYSTEM_ACTOR_ID,
    actorKind: "system",
    requestId: crypto.randomUUID(),
  };
  const { adapter, registry } = getQueryContext();
  const result = await execute(registry, adapter, systemCtx, "pages.render_preview", {
    pageId: v.pageId,
    ...(v.chatBranchId ? { chatBranchId: v.chatBranchId } : {}),
  });
  if (!result.ok) throw error(404, "Page not found");

  return new Response((result.value as { html: string }).html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Never indexed, never framed — this exists solely for the capture
      // browser and short-lived token holders.
      "x-robots-tag": "noindex",
      "x-frame-options": "SAMEORIGIN",
    },
  });
};
