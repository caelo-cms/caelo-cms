// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7 — branch-aware live preview for the live-edit overlay's iframe.
 *
 * GET `/edit/preview/[pageId]?branch=<chatBranchId>` returns the
 * composed page HTML rendered through `pages.render_preview`, with the
 * P6.7 inject-script appended just before `</body>`. When `branch` is
 * present, the renderer overlays branch snapshots on top of live
 * module rows so the iframe shows the post-AI-edit view of the page.
 *
 * Read-only + content.write-gated. No CSRF (GET; the chat-stream POST
 * inside the overlay still carries `x-csrf-token`).
 */

import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { INJECT_SCRIPT } from "$lib/components/edit/inject-script.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

const BODY_CLOSE_RE = /<\/body\s*>/i;

export const GET: RequestHandler = async ({ params, url, locals }) => {
  requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();

  const branch = url.searchParams.get("branch");
  const result = await execute(registry, adapter, locals.ctx, "pages.render_preview", {
    pageId: params.pageId,
    ...(branch ? { chatBranchId: branch } : {}),
  });
  if (!result.ok) {
    throw error(404, "Page not found");
  }
  const composed = result.value as { html: string };
  const scriptTag = `<script data-caelo-edit-overlay>${INJECT_SCRIPT}</script>`;
  const html = BODY_CLOSE_RE.test(composed.html)
    ? composed.html.replace(BODY_CLOSE_RE, `${scriptTag}</body>`)
    : composed.html + scriptTag;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The overlay loads us in an iframe on the same origin; deny
      // cross-origin embedding to keep `postMessage` from drifting to a
      // foreign window.
      "x-frame-options": "SAMEORIGIN",
    },
  });
};
