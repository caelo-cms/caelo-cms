// SPDX-License-Identifier: MPL-2.0

/**
 * #1757 — `duplicate-title` and `duplicate-description`: indexable pages
 * of the staged build that share their `<title>` or meta description. A
 * search engine then cannot tell them apart in its results, and picks one.
 *
 * Read on the audit's first call, which names every staged page: their
 * heads as the build renders them (`pages_seo.overview`, a thousand pages a
 * call, the main line the Stage built). A page left out of search (noindex)
 * or pointed at another page by its canonical is no duplicate: it does not
 * compete. Language versions of one page that share a title are versions,
 * not duplicates, and are accepted per page.
 */

import { type PluginAuditFinding, type PluginContextTier1, z } from "@caelo-cms/plugin-sdk";
import type { SeoAuditRule } from "../checks/index.js";

/** Pages one overview call names. */
const IDS_PER_CALL = 1000;
/** Pages of one group a message names. */
const NAMED = 5;

const head = z
  .object({
    pageId: z.string(),
    path: z.string(),
    seoTitle: z.object({ value: z.string() }).passthrough(),
    metaDescription: z.object({ value: z.string() }).passthrough(),
    noindex: z.boolean(),
    canonicalUrl: z.string().nullable(),
  })
  .passthrough();

const answer = z.object({ pages: z.array(head), nextCursor: z.string().nullable() }).strict();

type Head = z.infer<typeof head>;

/** The findings of pages that share one text, each page once. */
export function duplicateFindings(
  heads: readonly Head[],
  field: "seoTitle" | "metaDescription",
): PluginAuditFinding[] {
  const groups = new Map<string, Head[]>();
  for (const h of heads) {
    if (h.noindex || h.canonicalUrl !== null) continue;
    const text = h[field].value.replace(/\s+/g, " ").trim();
    if (text === "") continue;
    groups.set(text, [...(groups.get(text) ?? []), h]);
  }
  const what = field === "seoTitle" ? "title" : "description";
  const out: PluginAuditFinding[] = [];
  for (const [text, group] of groups) {
    if (group.length < 2) continue;
    for (const h of group) {
      const others = group.filter((g) => g !== h).map((g) => g.path);
      out.push({
        rule: field === "seoTitle" ? "duplicate-title" : "duplicate-description",
        severity: "error",
        pageId: h.pageId,
        message: `Duplicate ${what}: ${h.path} shares its ${field === "seoTitle" ? "<title>" : "meta description"} "${text.slice(0, 80)}" with ${others.slice(0, NAMED).join(", ")}${others.length > NAMED ? ` and ${others.length - NAMED} more` : ""}, so search engines cannot tell the pages apart. Versions of one page in different languages may share it: accept the finding for them.`,
        fix: {
          tool: "bulk_optimize_seo",
          hint:
            field === "seoTitle"
              ? "Give each page a title that says what sets it apart (seoTitle), or a page type template with a variable such as {page_title}."
              : "Write each page a description of its own content (metaDescription).",
        },
      });
    }
  }
  return out;
}

/** The heads of `pageIds` as the build renders them. */
async function headsOf(ctx: PluginContextTier1, pageIds: readonly string[]): Promise<Head[]> {
  if (!ctx.cms) throw new Error("seo: the cms_admin grant is missing, so page SEO cannot be read");
  const out: Head[] = [];
  for (let at = 0; at < pageIds.length; at += IDS_PER_CALL) {
    const r = answer.parse(
      await ctx.cms.call("pages_seo.overview", {
        pageIds: pageIds.slice(at, at + IDS_PER_CALL),
        withFindings: false,
      }),
    );
    out.push(...r.pages);
  }
  return out;
}

/** The duplicate rule family (site-wide, on the audit's first call). */
export const DUPLICATES_AUDIT_RULE: SeoAuditRule = {
  name: "duplicates",
  async site(ctx, { pages }) {
    const heads = await headsOf(
      ctx,
      pages.map((p) => p.pageId),
    );
    return [
      ...duplicateFindings(heads, "seoTitle"),
      ...duplicateFindings(heads, "metaDescription"),
    ];
  },
};
