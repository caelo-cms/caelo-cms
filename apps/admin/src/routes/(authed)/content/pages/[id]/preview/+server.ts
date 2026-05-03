// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

/**
 * Returns the composed preview HTML for one page id. Render gets `content.read`
 * (anyone authoring or reviewing can see it). The composed bytes are framed by
 * the parent page in an `<iframe sandbox="allow-scripts">` so module CSS/JS
 * cannot leak into the admin shell.
 *
 * Cache-Control: no-store — the editor expects every refresh to reflect the
 * latest module HTML (live references; CMS_REQUIREMENTS §3.2).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const result = await execute(registry, adapter, locals.ctx, "pages.render_preview", {
    pageId: params.id,
  });
  if (!result.ok) throw error(404, "Page not found");
  const { html } = result.value as { html: string };
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
};
