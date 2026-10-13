// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #678 — the pages a Stage / Publish live leaves out.
 *
 * Both builds ship only `status = 'published'` pages of main (the
 * generator's filter, apps/static-generator generate.ts). A draft page is
 * therefore silently absent from staging — the operator (or the AI) sees a
 * "successful" Stage and a 404 on the page they just built. Every surface
 * that reports a build or the staging site names these pages and the next
 * step instead.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { z } from "zod";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** How many draft pages a report lists by name (the count is always exact). */
export const DRAFT_PAGES_LISTED = 20;

/** Draft pages on main: the exact count and the first {@link DRAFT_PAGES_LISTED}. */
export const draftPagesSummary = z.object({
  count: z.number().int(),
  pages: z.array(z.object({ id: z.string(), title: z.string(), path: z.string() })),
});
export type DraftPagesSummary = z.infer<typeof draftPagesSummary>;

/** The draft pages of main (not deleted, not on a chat branch), by path. */
export async function mainDraftPages(tx: Tx): Promise<DraftPagesSummary> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, title, current_path AS path, count(*) OVER () AS total
    FROM pages
    WHERE status = 'draft' AND deleted_at IS NULL AND chat_branch_id IS NULL
    ORDER BY current_path
    LIMIT ${DRAFT_PAGES_LISTED}
  `)) as unknown as { id: string; title: string; path: string; total: string | number }[];
  return {
    count: rows.length > 0 ? Number(rows[0]?.total) : 0,
    pages: rows.map((r) => ({ id: r.id, title: r.title, path: r.path })),
  };
}

/**
 * One sentence naming the draft pages a build left out and the next step,
 * or null when there are none. Worded for both the operator and the AI.
 */
export function describeDraftPages(drafts: DraftPagesSummary): string | null {
  if (drafts.count === 0) return null;
  const listed = drafts.pages.map((p) => `'${p.title}' (${p.path})`).join(", ");
  const more =
    drafts.count > drafts.pages.length ? ` and ${drafts.count - drafts.pages.length} more` : "";
  return (
    `${drafts.count} page(s) are draft and NOT included: ${listed}${more}. ` +
    "Only pages with status 'published' are staged — set them to published (set_pages_status_many, or the status toggle in the editor) and Stage again to include them."
  );
}
