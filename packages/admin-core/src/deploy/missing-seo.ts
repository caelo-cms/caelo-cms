// SPDX-License-Identifier: MPL-2.0

/**
 * SEO fill-once, enforced at the build (CLAUDE.md §2: "AI fills SEO fields
 * before first publish via seo-autofill").
 *
 * The rule used to live only in prose — a skill the matcher engages on SEO
 * keywords, a tool description — so a page built in a chat that never
 * talked about SEO (a site migration, a "build me a pricing page") reached
 * staging and production with an empty description. The generator then
 * rendered no `<meta name="description">` at all (`renderSeoHead` omits it
 * when the value is empty, and a page without a `pages_seo` row reads as
 * empty), and only Lighthouse noticed, after go-live.
 *
 * So a staging or production build refuses while any page it would ship
 * (`status = 'published'` on main — the generator's own filter) has no
 * meta description. The refusal names the pages and the tools that fix
 * them; there is deliberately no default description (no fallbacks pre-1.0).
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** How many pages a refusal lists by name and id (the count is always exact). */
export const MISSING_SEO_PAGES_LISTED = 50;

/** A page the build would ship without a meta description. */
export interface PageMissingMetaDescription {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  /** The fill-once marker is set: `autofill_page_seo_many` refuses this page. */
  readonly alreadyAutofilled: boolean;
}

/** Pages without a meta description: the exact count and the first few. */
export interface MissingMetaDescriptions {
  readonly count: number;
  readonly pages: readonly PageMissingMetaDescription[];
}

/**
 * The pages a staging / production build would ship without a meta
 * description: published, not deleted, on main, and either no `pages_seo`
 * row or a blank description.
 */
export async function pagesMissingMetaDescription(tx: Tx): Promise<MissingMetaDescriptions> {
  const rows = (await tx.execute(sql`
    SELECT p.id::text AS id, p.title, p.current_path AS path,
           (s.autofilled_at IS NOT NULL) AS already_autofilled,
           count(*) OVER () AS total
    FROM pages p
    LEFT JOIN pages_seo s ON s.page_id = p.id
    WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
      AND btrim(coalesce(s.meta_description, '')) = ''
    ORDER BY p.current_path
    LIMIT ${MISSING_SEO_PAGES_LISTED}
  `)) as unknown as {
    id: string;
    title: string;
    path: string;
    already_autofilled: boolean;
    total: string | number;
  }[];
  return {
    count: rows.length > 0 ? Number(rows[0]?.total) : 0,
    pages: rows.map((r) => ({
      id: r.id,
      title: r.title,
      path: r.path,
      alreadyAutofilled: r.already_autofilled,
    })),
  };
}

/**
 * The refusal message for a build that would ship pages without a meta
 * description, or null when there are none. Worded for the AI (page ids,
 * the exact tools) and readable for the operator.
 */
export function describeMissingMetaDescriptions(missing: MissingMetaDescriptions): string | null {
  if (missing.count === 0) return null;
  const listed = missing.pages
    .map(
      (p) =>
        `'${p.title}' (${p.path}, pageId ${p.id}${p.alreadyAutofilled ? ", already autofilled" : ""})`,
    )
    .join(", ");
  const more =
    missing.count > missing.pages.length
      ? ` and ${missing.count - missing.pages.length} more (the next attempt names them once these are fixed)`
      : "";
  const refilled = missing.pages.some((p) => p.alreadyAutofilled)
    ? " A page marked 'already autofilled' had its description removed after the first fill: autofill refuses it, so set it with set_page_seo_many instead."
    : "";
  return (
    `${missing.count} page(s) would go live without a meta description: ${listed}${more}. ` +
    "Every published page needs one before it is built. Write each from the page's content " +
    "(150–160 characters; ONE get_page_seo({pageIds}) call returns every page's core text; when " +
    "migrating a site, carry over the source page's description) with " +
    "autofill_page_seo_many — one call for all of them — " +
    `then Stage again.${refilled}`
  );
}
