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
 * Only the newest {@link SNAPSHOT_WINDOW} snapshots are looked through, so
 * the cost stays flat however long the history grows: "recent" means
 * recent, and a page last touched before that window is found by searching
 * for it. They are read newest first, {@link SNAPSHOT_BATCH} at a time,
 * main's and the branch's each from its own range of an index (0760), and
 * each one's pages through the snapshot tables' `site_snapshot_id` index,
 * until `limit` pages are found (#1676). One statement over the whole
 * window joined the snapshot tables by hash, which read every page
 * snapshot and every page of the site (3,200 buffers per call on the
 * nightly gate's 50,000 pages, once per editor opening a page); and on
 * main, or on an isolated branch, it walked every other branch's newest
 * snapshots to find its own.
 */

import { defineOperation, uuidArray } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

/** How many of the newest snapshots the read looks through. */
const SNAPSHOT_WINDOW = 500;

/** How many snapshots one statement reads: most calls need only the first batch. */
const SNAPSHOT_BATCH = 100;

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
    // Main and the caller's branch, each one ordered range of
    // `site_snapshots_branch_created_idx` (0760), merged newest first.
    const lines = ctx.chatBranchId
      ? [sql`ss.chat_branch_id IS NULL`, sql`ss.chat_branch_id = ${ctx.chatBranchId}::uuid`]
      : [sql`ss.chat_branch_id IS NULL`];
    const pageBranchFilter = ctx.chatBranchId
      ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql`p.chat_branch_id IS NULL`;
    // Newest first, so a page's first appearance is its latest edit.
    const pages: { pageId: string; editedAt: string }[] = [];
    const seen = new Set<string>();
    let after: { readonly createdAt: string; readonly id: string } | null = null;
    for (let read = 0; read < SNAPSHOT_WINDOW && pages.length < input.limit; ) {
      const take = Math.min(SNAPSHOT_BATCH, SNAPSHOT_WINDOW - read);
      const rows = (await tx.execute(sql`
        WITH recent AS (
          SELECT u.id, u.created_at FROM (${sql.join(
            lines.map(
              (line) => sql`(SELECT ss.id, ss.created_at FROM site_snapshots ss
                 WHERE ${line}
                   ${after ? sql`AND (ss.created_at, ss.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)` : sql``}
                 ORDER BY ss.created_at DESC, ss.id DESC
                 LIMIT ${take})`,
            ),
            sql` UNION ALL `,
          )}) u
          ORDER BY u.created_at DESC, u.id DESC
          LIMIT ${take}
        )
        SELECT r.id::text AS snapshot_id, r.created_at::text AS created_at,
               t.page_id::text AS page_id
          FROM recent r
          LEFT JOIN LATERAL (
            SELECT ps.page_id FROM page_snapshots ps WHERE ps.site_snapshot_id = r.id
            UNION
            SELECT pl.page_id FROM page_layout_snapshots pl WHERE pl.site_snapshot_id = r.id
            UNION
            SELECT pc.page_id FROM page_module_content_snapshots pc WHERE pc.site_snapshot_id = r.id
          ) t ON true
         ORDER BY r.created_at DESC, r.id DESC
      `)) as unknown as { snapshot_id: string; created_at: string; page_id: string | null }[];
      const last = rows.at(-1);
      if (!last) break;
      const candidates: { pageId: string; editedAt: string }[] = [];
      let snapshots = 0;
      let previous: string | null = null;
      for (const r of rows) {
        if (r.snapshot_id !== previous) snapshots += 1;
        previous = r.snapshot_id;
        if (r.page_id === null || seen.has(r.page_id)) continue;
        seen.add(r.page_id);
        candidates.push({ pageId: r.page_id, editedAt: r.created_at });
      }
      if (candidates.length > 0) {
        const live = new Set(
          (
            (await tx.execute(sql`
              SELECT p.id::text AS id FROM pages p
               WHERE p.id = ANY(${uuidArray(candidates.map((c) => c.pageId))})
                 AND p.deleted_at IS NULL AND ${pageBranchFilter}
            `)) as unknown as { id: string }[]
          ).map((r) => r.id),
        );
        for (const c of candidates) if (live.has(c.pageId)) pages.push(c);
      }
      read += snapshots;
      if (snapshots < take) break;
      after = { createdAt: last.created_at, id: last.snapshot_id };
    }
    return ok({
      pages: pages.slice(0, input.limit).map((p) => ({
        pageId: p.pageId,
        editedAt: new Date(p.editedAt).toISOString(),
      })),
    });
  },
});
