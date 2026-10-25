// SPDX-License-Identifier: MPL-2.0

import { pluginsNotRunningHere } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import {
  previewPluginProblems,
  withPluginProblemsBanner,
} from "#lib/server/plugin-problems-banner.js";
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
  if (!result.ok) {
    // Only a missing page is a 404 — a render failure reported as "not
    // found" hides its cause (same rule as edit/preview/[pageId]).
    const message = "message" in result.error ? String(result.error.message) : result.error.kind;
    if (message === "page not found") throw error(404, "Page not found");
    throw error(500, `Preview render failed: ${message}`);
  }
  const { html, pluginFailures } = result.value as {
    html: string;
    pluginFailures?: { slug: string; reason: string }[];
  };
  const problems = previewPluginProblems(pluginsNotRunningHere(), pluginFailures);
  return previewDocumentResponse(withPluginProblemsBanner(html, problems), {
    cookies,
    userId: user.id,
  });
};
