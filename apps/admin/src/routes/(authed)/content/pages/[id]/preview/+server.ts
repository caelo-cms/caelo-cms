// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { previewDocumentResponse } from "#lib/server/preview-sandbox.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

/**
 * Returns the composed preview HTML for one page id. Render gets `content.read`
 * (anyone authoring or reviewing can see it). The page detail view opens it in
 * a new tab, so the document sandboxes ITSELF (#946, CSP `sandbox
 * allow-scripts`): module scripts run in an opaque origin, never with the
 * operator's admin session.
 *
 * Cache-Control: no-store — the editor expects every refresh to reflect the
 * latest module HTML (live references; CMS_REQUIREMENTS §3.2).
 */
export const GET: RequestHandler = async ({ params, locals, cookies }) => {
  const user = requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const result = await execute(registry, adapter, locals.ctx, "pages.render_preview", {
    pageId: params.id,
  });
  if (!result.ok) throw error(404, "Page not found");
  const { html } = result.value as { html: string };
  return previewDocumentResponse(html, { cookies, userId: user.id });
};
