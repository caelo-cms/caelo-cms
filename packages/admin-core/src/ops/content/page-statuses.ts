// SPDX-License-Identifier: MPL-2.0

/**
 * #1213 — `pages.list_statuses`: the publication status of named pages,
 * for render-time plugin hooks.
 *
 * international-site emits hreflang and the language switcher only
 * between PUBLISHED variants. It used to learn which ones are published
 * from `pages.list` — every page of the site, its tree, page types and
 * properties — once per composition point, on every preview. A preview
 * concerns one page and its few variants, so its cost must not grow with
 * the site: this read takes exactly the ids the hook needs.
 *
 * Same visibility as `pages.list`: main plus the caller's own branched
 * creates, deleted pages left out, and on a chat branch the chat's
 * pending status changes and deletes applied (its latest pending
 * snapshot per page).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { pendingSnapshotSql } from "../../draft.js";

/** One read's id ceiling, the same as `pages.resolve_public_urls`. */
const MAX_PAGE_IDS = 1000;

export const listPageStatusesOp = defineOperation({
  name: "pages.list_statuses",
  // Why system-only (plugins included): a render-time building block like
  // `pages.resolve_public_urls`, called by plugin render hooks with the ids
  // they already hold. The AI and the panel read statuses from pages.list.
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageIds: z.array(z.string().uuid()).min(1).max(MAX_PAGE_IDS),
    })
    .strict(),
  output: z.object({
    /** pageId → status, for every visible page among the ids. A deleted
     *  or invisible page is absent: it is not part of this scope's site. */
    statuses: z.record(z.string(), z.enum(["draft", "published"])),
  }),
  handler: async (ctx, input, tx) => {
    const ids = sql.join(
      [...new Set(input.pageIds)].map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const branchFilter = ctx.chatBranchId
      ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql`p.chat_branch_id IS NULL`;
    const rows = (await tx.execute(sql`
      SELECT p.id::text AS id, p.status
        FROM pages p
       WHERE p.id IN (${ids}) AND p.deleted_at IS NULL AND ${branchFilter}
    `)) as unknown as { id: string; status: "draft" | "published" }[];
    const statuses: Record<string, "draft" | "published"> = {};
    for (const r of rows) statuses[r.id] = r.status;
    if (ctx.chatBranchId && rows.length > 0) {
      // A branched status change or delete lives in the chat's pending
      // snapshots until publish (pages.list applies the same overlay).
      const overlay = (await tx.execute(sql`
        SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
          FROM page_snapshots ps
          JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
         WHERE ss.chat_branch_id = ${ctx.chatBranchId}::uuid AND ${pendingSnapshotSql()}
           AND ps.page_id IN (${ids})
         ORDER BY ps.page_id, ss.created_at DESC
      `)) as unknown as { page_id: string; state: unknown }[];
      for (const o of overlay) {
        if (!(o.page_id in statuses)) continue;
        const state = o.state as {
          status?: "draft" | "published";
          deletedAt?: string | null;
        };
        if (state.deletedAt) delete statuses[o.page_id];
        else if (state.status) statuses[o.page_id] = state.status;
      }
    }
    return ok({ statuses });
  },
});
