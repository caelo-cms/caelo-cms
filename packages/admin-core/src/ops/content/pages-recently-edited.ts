// SPDX-License-Identifier: MPL-2.0

/**
 * `pages.list_recently_edited`: the pages changed last, newest first, for
 * the live editor's page search (#1207). Opening the search shows them
 * before anything is typed: the page an editor opens next is usually one
 * they or the AI just worked on.
 *
 * "Changed" is read from the snapshot history every write emits (§2):
 * a page's own row (title, slug, status, SEO), its module layout and its
 * placement content. Edits to a shared module or content instance are not
 * attributed to every page that shows them. The caller sees main plus its
 * own chat branch (the shared draft), like `pages.list`.
 *
 * Only the newest {@link SNAPSHOT_WINDOW} snapshots are read, so the cost
 * stays flat however long the history grows: "recent" means recent, and a
 * page last touched before that window is found by searching for it.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

/** How many of the newest snapshots the read looks through. */
const SNAPSHOT_WINDOW = 500;

export const listRecentlyEditedPagesOp = defineOperation({
  name: "pages.list_recently_edited",
  readScope: "request",
  // Why human-only (system for tests): a navigation aid of the editor's
  // page search. The AI reads what changed through the chat's own change
  // list and a page's log (`get_page_log`), which say what changed, not only when.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(20).default(8) }).strict(),
  output: z.object({
    pages: z.array(z.object({ pageId: z.string().uuid(), editedAt: z.string() })),
  }),
  handler: async (ctx, input, tx) => {
    const branchFilter = ctx.chatBranchId
      ? sql`(ss.chat_branch_id IS NULL OR ss.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql`ss.chat_branch_id IS NULL`;
    const pageBranchFilter = ctx.chatBranchId
      ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql`p.chat_branch_id IS NULL`;
    const rows = (await tx.execute(sql`
      WITH recent AS (
        SELECT ss.id, ss.created_at
          FROM site_snapshots ss
         WHERE ${branchFilter}
         ORDER BY ss.created_at DESC
         LIMIT ${SNAPSHOT_WINDOW}
      ), touched AS (
        SELECT ps.page_id, r.created_at FROM recent r
          JOIN page_snapshots ps ON ps.site_snapshot_id = r.id
        UNION ALL
        SELECT pl.page_id, r.created_at FROM recent r
          JOIN page_layout_snapshots pl ON pl.site_snapshot_id = r.id
        UNION ALL
        SELECT pc.page_id, r.created_at FROM recent r
          JOIN page_module_content_snapshots pc ON pc.site_snapshot_id = r.id
      )
      SELECT t.page_id::text AS page_id, max(t.created_at) AS edited_at
        FROM touched t
        JOIN pages p ON p.id = t.page_id
       WHERE p.deleted_at IS NULL AND ${pageBranchFilter}
       GROUP BY t.page_id
       ORDER BY edited_at DESC
       LIMIT ${input.limit}
    `)) as unknown as { page_id: string; edited_at: string | Date }[];
    return ok({
      pages: rows.map((r) => ({
        pageId: r.page_id,
        editedAt: new Date(r.edited_at).toISOString(),
      })),
    });
  },
});
