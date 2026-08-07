// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.2 → #390 — path-aware live preview for the chrome-less /edit
 * surface.
 *
 * GET `/edit/preview-by-path/<...path>?branch=<chatBranchId>` resolves
 * the COMPOSED public path against `pages.currentPath` (the
 * materialized URL-composition result, so plugin prefixes work), then
 * delegates to `pages.render_preview` (branch-aware) and splices the
 * inject-script before `</body>`.
 *
 * The iframe inside /edit loads this path-based URL so a relative
 * `<a href="/de/about">` click inside the iframe naturally navigates to
 * `/edit/preview-by-path/de/about` — no JS interception required for
 * plain link navigation.
 *
 * Read-only + content.write-gated. CSRF not needed (GET-only).
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { error } from "@sveltejs/kit";
import { INJECT_SCRIPT } from "$lib/components/edit/inject-script.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

interface PageRow {
  id: string;
  slug: string;
  currentPath: string;
}

const BODY_CLOSE_RE = /<\/body\s*>/i;

export const GET: RequestHandler = async ({ params, url, locals }) => {
  requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();

  // #390 — the inbound path matches `pages.currentPath` verbatim
  // (composed shape; "/" is the designated root, whatever its slug).
  const trimmed = (params.path ?? "").replace(/^\/+|\/+$/g, "");
  const lookupPath = trimmed.length === 0 ? "/" : `/${trimmed}`;

  // v0.9.6 — branch-aware ctx for the page lookup. Without this, a page
  // the AI just created on a chat branch (chat_branch_id NOT NULL) is
  // hidden by `branchVisibilityFilter` and the iframe sees a 404 — even
  // though render_preview below was already being told the branch via
  // `chatBranchId`. The render call was branch-aware; the LOOKUP wasn't.
  const branch = url.searchParams.get("branch");
  const ctxWithBranch: ExecutionContext = branch
    ? { ...locals.ctx, chatBranchId: branch }
    : locals.ctx;

  const pagesR = await execute(registry, adapter, ctxWithBranch, "pages.list", {});
  if (!pagesR.ok) throw error(500, "Could not list pages");
  const pages = (pagesR.value as { pages: PageRow[] }).pages;
  // Primary: composed-path match. Legacy slug match keeps pre-#390
  // bookmarks working when no URL plugin has reshaped anything (then
  // currentPath === "/<slug>" and both branches agree).
  const page =
    pages.find((p) => p.currentPath === lookupPath) ??
    pages.find((p) => p.slug === (trimmed.length === 0 ? "home" : trimmed));
  if (!page) throw error(404, `No page at ${lookupPath}`);

  // P6.6b — `?exclude=<moduleId>,<moduleId>` lets the chat-side diff
  // panel render a partial-publish view: the right iframe excludes
  // specific module ids from the branch overlay so the user previews
  // what the page looks like with a subset of edits rolled back.
  const excludeRaw = url.searchParams.get("exclude");
  const excludeBranchModules = excludeRaw
    ? excludeRaw.split(",").filter((id) => id.length > 0)
    : undefined;
  const composed = await execute(registry, adapter, ctxWithBranch, "pages.render_preview", {
    pageId: page.id,
    ...(branch ? { chatBranchId: branch } : {}),
    ...(excludeBranchModules ? { excludeBranchModules } : {}),
  });
  if (!composed.ok) throw error(404, "Page render failed");

  const out = composed.value as { html: string };
  // The inject-script needs to know its own pageId/slug so it can
  // post `caelo:navigated` to the parent on every iframe load. We thread
  // those through `window.__caelo` before the runtime executes.
  const ctx = `window.__caelo=${JSON.stringify({ pageId: page.id, slug: page.slug, path: page.currentPath })};`;
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
