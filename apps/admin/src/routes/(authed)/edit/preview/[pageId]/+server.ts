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
 * Served sandboxed (#946, `preview-sandbox.ts`): the page's module scripts
 * run in an opaque origin, never with the operator's admin session.
 *
 * Read-only + content.write-gated. No CSRF (GET; the chat-stream POST
 * inside the overlay still carries `x-csrf-token`). The branch is
 * authorized by the Query API itself (issue #569): one the caller may not
 * see answers 404.
 */

import { pluginsNotRunningHere } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { injectEditOverlay } from "#lib/server/edit-overlay.js";
import { requirePermission } from "#lib/server/guards.js";
import {
  previewPluginProblems,
  withPluginProblemsBanner,
} from "#lib/server/plugin-problems-banner.js";
import { previewDocumentResponse } from "#lib/server/preview-sandbox.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url, locals, cookies }) => {
  const user = requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();

  const branch = url.searchParams.get("branch");
  const result = await execute(registry, adapter, locals.ctx, "pages.render_preview", {
    pageId: params.pageId,
    ...(branch ? { chatBranchId: branch } : {}),
  });
  if (!result.ok) {
    // Only a missing page is a 404. Any other failure (a layout without a
    // content block, a plugin gate that cannot render its placeholder, …)
    // is surfaced with its message: reporting it as "not found" hid the
    // real cause from the operator and the AI alike.
    // Issue #569 — a branch the caller may not see is a 404 too, worded
    // like a missing one so a guessed id confirms nothing.
    if (result.error.kind === "BranchNotFound") throw error(404, "Branch not found");
    const message = "message" in result.error ? String(result.error.message) : result.error.kind;
    if (message === "page not found") throw error(404, "Page not found");
    throw error(500, `Preview render failed: ${message}`);
  }
  const composed = result.value as {
    html: string;
    pluginFailures?: { slug: string; reason: string }[];
  };
  const html = injectEditOverlay(
    withPluginProblemsBanner(
      composed.html,
      previewPluginProblems(pluginsNotRunningHere(), composed.pluginFailures),
    ),
  );

  // #946 — the module scripts in this page are untrusted: the document is
  // sandboxed into an opaque origin (CSP), never run as the operator.
  return previewDocumentResponse(html, { cookies, userId: user.id });
};
