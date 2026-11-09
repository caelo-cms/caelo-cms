// SPDX-License-Identifier: MPL-2.0

/**
 * #1447 — redirect rules sitting on the URL of a page, by the pages or by the
 * paths just written. A rule never beats a page a build serves (the redirect
 * plan leaves it out on every provider), but until a build ships the page the
 * rule answers the URL, and once it does the rule does nothing. Write tools
 * read this to say so at once; a Stage reports what is left
 * (`links/redirect-shadows-page`, or `links/redirect-taken-over` for a page
 * that was never live: #1517, the Publish live that first ships it deletes
 * the rule).
 *
 * Pages come from `pages.list`, so a chat sees its own pending renames, moves
 * and deletes. Rules are live state, so they are read directly. O(request):
 * `pages.list` selects by id or path, and `redirects.from_path` is unique.
 */

import { defineOperation, type TransactionRunner, textArray } from "@caelo-cms/query-api";
import { type ExecutionContext, ok, redirectFromPathSpellings } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { loadSiteDesignations } from "./compose-paths.js";
import { listPagesOp } from "./pages.js";

/** How many paths or pages one call takes. */
const MAX_LOOKUPS = 500;

/** A redirect rule on the URL of a page. */
const redirectPageConflictSchema = z.object({
  /** The stored from path, as `bulk_delete_redirects` takes it. */
  fromPath: z.string(),
  toPath: z.string(),
  statusCode: z.number().int(),
  pageId: z.string(),
  pagePath: z.string(),
  pageTitle: z.string(),
  pageStatus: z.string(),
  /**
   * #1517 — whether a Publish live has shipped the page before. A page that
   * was never live takes its URL over at the Publish live that first ships
   * it (the rule is deleted then); until then the rule keeps answering on
   * the live site.
   */
  pageLive: z.boolean(),
});

export type RedirectPageConflict = z.infer<typeof redirectPageConflictSchema>;

type ConflictLookup = { pageIds?: string[]; paths?: string[] };

/**
 * The caller's pages behind these ids or paths, by every spelling a rule can
 * hold for their URL (without the 404 page, whose own path is free for a
 * rule). #1358 — also what a proposal asks, before its rule exists.
 */
export async function pagesByRedirectSpelling(
  ctx: ExecutionContext,
  input: ConflictLookup,
  tx: TransactionRunner,
) {
  const listed = await listPagesOp.handler(
    ctx,
    {
      includeDeleted: false,
      ...(input.pageIds ? { pageIds: input.pageIds } : { paths: input.paths }),
    },
    tx,
  );
  if (!listed.ok) return listed;
  // The 404 page is served at /404.html, so its own path is free for a rule.
  const { notFoundPageId } = await loadSiteDesignations(tx, ctx.chatBranchId ?? null);
  const pages = listed.value.pages.filter((p) => p.id !== notFoundPageId);
  return ok(
    new Map(
      pages.flatMap((p) => redirectFromPathSpellings(p.currentPath).map((s) => [s, p] as const)),
    ),
  );
}

export const pageConflictsRedirectOp = defineOperation({
  name: "redirects.page_conflicts",
  readScope: "request",
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageIds: z.array(z.string().uuid()).max(MAX_LOOKUPS).optional(),
      paths: z.array(z.string().min(1).max(500)).max(MAX_LOOKUPS).optional(),
    })
    .strict()
    .refine(
      (v) => Number(!!v.pageIds) + Number(!!v.paths) === 1,
      "exactly one of pageIds / paths is required",
    ),
  output: z.object({ conflicts: z.array(redirectPageConflictSchema) }),
  handler: async (ctx, input, tx) => {
    if ((input.pageIds ?? input.paths ?? []).length === 0) return ok({ conflicts: [] });
    const pages = await pagesByRedirectSpelling(ctx, input, tx);
    if (!pages.ok) return pages;
    const bySpelling = pages.value;
    if (bySpelling.size === 0) return ok({ conflicts: [] });
    const rows = (await tx.execute(sql`
      SELECT from_path, to_path, status_code FROM redirects
      WHERE from_path = ANY(${textArray([...bySpelling.keys()])})
      ORDER BY from_path
    `)) as unknown as { from_path: string; to_path: string; status_code: number }[];
    return ok({
      conflicts: rows.flatMap((r) => {
        const page = bySpelling.get(r.from_path);
        if (!page) return [];
        return [
          {
            fromPath: r.from_path,
            toPath: r.to_path,
            statusCode: r.status_code,
            pageId: page.id,
            pagePath: page.currentPath,
            pageTitle: page.title,
            pageStatus: page.status,
            pageLive: page.firstPublishedAt !== null,
          },
        ];
      }),
    });
  },
});
