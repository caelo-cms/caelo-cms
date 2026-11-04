// SPDX-License-Identifier: MPL-2.0

/**
 * #1269 — the editor's page search: `GET /api/pages/search?q=<words>&branch=<chatBranchId>`
 * answers `pages.search` in the chat's view, so the address bar's search
 * and the preview's link-target suggestions read the pages they find
 * instead of the editor loading every page of the site. The Query API
 * refuses a branch the caller may not see.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

/** What the editor's search shows of a page, and opens when it is picked. */
interface SearchedPage {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly status: "draft" | "published";
  readonly currentPath: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ locals, url }) => {
  requirePermission(locals, "content.read");
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (query === "") return json({ pages: [], more: false });
  const branch = url.searchParams.get("branch");
  if (branch !== null && !UUID_RE.test(branch)) error(400, "branch must be a chat branch id");
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "30") || 30));
  const ctx: ExecutionContext = branch ? { ...locals.ctx, chatBranchId: branch } : locals.ctx;
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "pages.search", { query, limit });
  if (!r.ok) {
    // A branch the caller may not see answers like one that does not exist.
    if (r.error.kind === "BranchNotFound") error(404, "Branch not found");
    error(500, opErrorMessage(r.error, "The page search failed"));
  }
  const v = r.value as { pages: SearchedPage[]; nextCursor: string | null };
  return json({
    pages: v.pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      status: p.status,
      currentPath: p.currentPath,
    })),
    more: v.nextCursor !== null,
  });
};
