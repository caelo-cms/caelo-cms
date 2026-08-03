// SPDX-License-Identifier: MPL-2.0

/**
 * issue #375 — design-draft preview for the chat's variant cards and
 * the /design/genesis gallery.
 *
 * GET `/design/drafts/[id]/preview` returns one draft as renderable
 * HTML via `genesis.render_draft`: site-scope documents pass through;
 * page/module-scope fragments are composed into the site's REAL theme
 * shell (theme vars, base CSS, resolved web fonts) at view time.
 *
 * The iframes embedding this route use `sandbox="allow-same-origin"`
 * WITHOUT `allow-scripts`: same-origin keeps the session cookie on
 * subresource requests (the /_caelo/fonts + /_caelo/media routes are
 * auth-gated), while script execution stays impossible — on top of
 * `sanitizeDraftHtml` stripping scripts at the storage boundary.
 *
 * Read-only + content.write-gated (the chat surface's permission — an
 * editor reviewing variants must not need the Owner's roles.manage).
 */

import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();

  const result = await execute(registry, adapter, locals.ctx, "genesis.render_draft", {
    draftId: params.id,
  });
  if (!result.ok) {
    throw error(404, "Draft not found");
  }
  const { html } = result.value as { html: string };

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Same-origin embedding only — the chat card and the gallery.
      "x-frame-options": "SAMEORIGIN",
    },
  });
};
