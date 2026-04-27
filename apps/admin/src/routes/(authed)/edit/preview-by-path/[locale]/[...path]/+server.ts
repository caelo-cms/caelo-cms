// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.2 — slug-aware live preview for the chrome-less /edit surface.
 *
 * GET `/edit/preview-by-path/<locale>/<...slug>?branch=<chatBranchId>`
 * resolves locale + slug to a pageId via `pages.list`, then delegates to
 * the existing `pages.render_preview` (branch-aware) and splices the
 * inject-script before `</body>`.
 *
 * The iframe inside /edit loads this slug-based URL so a relative
 * `<a href="/about">` click inside the iframe naturally navigates to
 * `/edit/preview-by-path/<locale>/about` — no JS interception required
 * for plain link navigation.
 *
 * Read-only + content.write-gated. CSRF not needed (GET-only).
 */

import { execute } from "@caelo/query-api";
import { error } from "@sveltejs/kit";
import { INJECT_SCRIPT } from "$lib/components/edit/inject-script.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

interface PageRow {
  id: string;
  slug: string;
  locale: string;
}

const BODY_CLOSE_RE = /<\/body\s*>/i;

export const GET: RequestHandler = async ({ params, url, locals }) => {
  requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();

  // Resolve locale + slug via `pages.list`. The path can contain slashes
  // (e.g. `blog/hello-world`) — the slug is the last segment for now;
  // multi-segment slugs are honoured verbatim because `pages.slug` is
  // already free-form text.
  const locale = params.locale;
  const path = (params.path ?? "").replace(/^\/+|\/+$/g, "");
  const slug = path.length === 0 ? "home" : path;

  const pagesR = await execute(registry, adapter, locals.ctx, "pages.list", {});
  if (!pagesR.ok) throw error(500, "Could not list pages");
  const pages = (pagesR.value as { pages: PageRow[] }).pages;
  const page = pages.find((p) => p.locale === locale && p.slug === slug);
  if (!page) throw error(404, `No page at ${locale}/${slug}`);

  const branch = url.searchParams.get("branch");
  const composed = await execute(registry, adapter, locals.ctx, "pages.render_preview", {
    pageId: page.id,
    ...(branch ? { chatBranchId: branch } : {}),
  });
  if (!composed.ok) throw error(404, "Page render failed");

  const out = composed.value as { html: string };
  // The inject-script needs to know its own pageId/locale/slug so it can
  // post `caelo:navigated` to the parent on every iframe load. We thread
  // those through `window.__caelo` before the runtime executes.
  const ctx = `window.__caelo=${JSON.stringify({ pageId: page.id, locale, slug })};`;
  const scriptTag = `<script data-caelo-edit-overlay>${ctx}${INJECT_SCRIPT}</script>`;
  const html = BODY_CLOSE_RE.test(out.html)
    ? out.html.replace(BODY_CLOSE_RE, `${scriptTag}</body>`)
    : out.html + scriptTag;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "SAMEORIGIN",
    },
  });
};
