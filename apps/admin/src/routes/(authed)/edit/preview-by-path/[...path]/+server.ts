// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.2 → #390 — path-aware live preview for the chrome-less /edit
 * surface.
 *
 * GET `/edit/preview-by-path/<...path>?branch=<chatBranchId>` renders the
 * page at that COMPOSED public path through `pages.render_preview`
 * (branch-aware; it matches `current_path`, the materialized
 * URL-composition result, so plugin prefixes work — and a page the chat
 * renamed or moved at its pending path) and splices the inject-script
 * before `</body>`. #1212 — one call: the op resolves the path from its
 * cached site view instead of this route listing every page first.
 *
 * The iframe inside /edit loads this path-based URL so a relative
 * `<a href="/de/about">` click inside the iframe naturally navigates to
 * `/edit/preview-by-path/de/about` — no JS interception required for
 * plain link navigation.
 *
 * Served sandboxed (#946, `preview-sandbox.ts`): the page's module scripts
 * run in an opaque origin, never with the operator's admin session.
 *
 * Read-only + content.write-gated. CSRF not needed (GET-only). The branch
 * is authorized by the Query API itself (issue #569): one the caller may
 * not see answers 404.
 */

import { pluginsNotRunningHere } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
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

  // #390 — the inbound path matches `pages.currentPath` verbatim
  // (composed shape; "/" is the designated root, whatever its slug).
  const trimmed = (params.path ?? "").replace(/^\/+|\/+$/g, "");
  const lookupPath = trimmed.length === 0 ? "/" : `/${trimmed}`;

  // v0.9.6 — branch-aware ctx: a page the AI just created on a chat
  // branch (chat_branch_id NOT NULL) is visible only in that branch's view.
  const branch = url.searchParams.get("branch");
  const ctxWithBranch: ExecutionContext = branch
    ? { ...locals.ctx, chatBranchId: branch }
    : locals.ctx;

  // P6.6b — `?exclude=<moduleId>,<moduleId>` lets the chat-side diff
  // panel render a partial-publish view: the right iframe excludes
  // specific module ids from the branch overlay so the user previews
  // what the page looks like with a subset of edits rolled back.
  const excludeRaw = url.searchParams.get("exclude");
  const excludeBranchModules = excludeRaw
    ? excludeRaw.split(",").filter((id) => id.length > 0)
    : undefined;
  const composed = await execute(registry, adapter, ctxWithBranch, "pages.render_preview", {
    path: lookupPath,
    ...(branch ? { chatBranchId: branch } : {}),
    ...(excludeBranchModules ? { excludeBranchModules } : {}),
    // #917 — field markers for in-place text editing.
    editMarkers: true,
  });
  if (!composed.ok) {
    // Issue #569 — the Query API refuses a branch the caller may not see;
    // answer 404 like for a branch that does not exist.
    if (composed.error.kind === "BranchNotFound") throw error(404, "Branch not found");
    // Only a missing page is a 404; any other failure is a render
    // failure, surfaced with its message (see preview/[pageId]).
    const message =
      "message" in composed.error ? String(composed.error.message) : composed.error.kind;
    if (message === "page not found") throw error(404, `No page at ${lookupPath}`);
    throw error(500, `Preview render failed: ${message}`);
  }

  const out = composed.value as {
    html: string;
    pluginFailures?: { slug: string; reason: string }[];
    pageId: string;
    pageSlug: string;
    pagePath: string;
  };
  // The inject-script needs to know its own pageId/slug so it can
  // post `caelo:navigated` to the parent on every iframe load. We thread
  // those through `window.__caelo` before the runtime executes.
  const html = injectEditOverlay(
    withPluginProblemsBanner(
      out.html,
      previewPluginProblems(pluginsNotRunningHere(), out.pluginFailures),
    ),
    {
      pageId: out.pageId,
      slug: out.pageSlug,
      path: out.pagePath,
    },
  );

  // #946 — the module scripts in this page are untrusted: the document is
  // sandboxed into an opaque origin (CSP), never run as the operator.
  return previewDocumentResponse(html, { cookies, userId: user.id });
};
