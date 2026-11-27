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
 *
 * And which of them are noindex: a noindex page takes no part in
 * hreflang, so the same hook that asks "published?" asks "indexable?"
 * about the same ids. Read through the caller's SEO view
 * (`pageSeoViewSql`), the one the preview's robots meta and, on main,
 * the build's come from, so hreflang and robots agree in a chat's
 * preview and in the staged build alike.
 */

import { defineOperation, uuidArray } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { headOverlaySql } from "../../draft.js";
import { pageSeoViewSql } from "../../seo/page-seo.js";

/** One read's id ceiling, the same as `pages.resolve_public_urls`. */
const MAX_PAGE_IDS = 1000;

export const listPageStatusesOp = defineOperation({
  name: "pages.list_statuses",
  pluginAccess: "read",
  readScope: "request",
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
    /** The pages among `statuses` whose SEO says noindex in the caller's view. */
    noindex: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    const ids = uuidArray([...new Set(input.pageIds)]);
    const branchFilter = ctx.chatBranchId
      ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql`p.chat_branch_id IS NULL`;
    const rows = (await tx.execute(sql`
      SELECT p.id::text AS id, p.status, coalesce(s.noindex, false) AS noindex
        FROM pages p
        LEFT JOIN ${pageSeoViewSql(ctx.chatBranchId, input.pageIds)} s ON s.page_id = p.id
       WHERE p.id = ANY(${ids}) AND p.deleted_at IS NULL AND ${branchFilter}
    `)) as unknown as { id: string; status: "draft" | "published"; noindex: boolean }[];
    const statuses: Record<string, "draft" | "published"> = {};
    for (const r of rows) statuses[r.id] = r.status;
    const noindex = new Set(rows.filter((r) => r.noindex).map((r) => r.id));
    if (ctx.chatBranchId && rows.length > 0) {
      // A branched status change or delete lives in the chat's pending
      // snapshots until publish (pages.list applies the same overlay).
      const overlay = (await tx.execute(sql`
        SELECT h.entity_id AS page_id, h.state FROM (${headOverlaySql({
          kind: "page",
          table: "page_snapshots",
          branchId: ctx.chatBranchId,
          ids: rows.map((r) => r.id),
        })}) h
      `)) as unknown as { page_id: string; state: unknown }[];
      for (const o of overlay) {
        if (!(o.page_id in statuses)) continue;
        const state = o.state as {
          status?: "draft" | "published";
          deletedAt?: string | null;
        };
        if (state.deletedAt) {
          delete statuses[o.page_id];
          noindex.delete(o.page_id);
        } else if (state.status) statuses[o.page_id] = state.status;
      }
    }
    return ok({ statuses, noindex: [...noindex] });
  },
});
