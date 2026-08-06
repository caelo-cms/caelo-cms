// SPDX-License-Identifier: MPL-2.0

/**
 * Internal-link integrity scan, run at stage/publish.
 *
 * Migrations (and ordinary editing) routinely author internal links —
 * `<a href="/pricing">`, a `link_href` content value of `/about` — that
 * point at pages which were never built, were renamed, or were deleted.
 * A dead internal link ships a 404 to a real visitor and strands SEO
 * authority. There is no compile step that would catch it, so we scan at
 * the stage/publish boundary: collect every internal href in the pages
 * being shipped and resolve each against the set of pages that will
 * exist, returning the ones that resolve to NO page.
 *
 * Loud-honesty (CLAUDE.md §2, §11): the scan NEVER blocks staging — it
 * surfaces a `brokenInternalLinks` list in the op result so the operator
 * (and the AI) see dead links BEFORE they reach production, rather than
 * silently letting them through OR hard-failing a publish over them.
 *
 * Bounded by design: exactly two queries (page slugs + home flag, then one
 * pass over placed modules) regardless of site size.
 */

import type { defineOperation } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** Result of {@link scanBranchInternalLinks}. */
export interface LinkIntegrityResult {
  /**
   * Distinct internal hrefs (as authored, e.g. `/pricing`) that resolve
   * to no existing page. Sorted for stable output. Empty when clean.
   */
  readonly brokenInternalLinks: string[];
  /** Total distinct internal hrefs examined — for a summary line. */
  readonly scannedCount: number;
}

/**
 * An internal link is a same-site path reference: starts with a single
 * `/` (not `//`, which is protocol-relative → external) and carries no
 * whitespace or angle brackets. Fragments (`#…`), `mailto:`/`tel:`, and
 * absolute `http(s)://` URLs are deliberately excluded — they can't be a
 * broken *internal* page link.
 */
function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && /^\/[^\s"'<>]*$/.test(href);
}

/**
 * Reduce an internal href to a slug-comparable path: drop the query +
 * fragment, then strip leading/trailing slashes. `/` and `/about/` both
 * normalize cleanly (`""` and `"about"`).
 */
function normalizePath(href: string): string {
  const noFragment = href.split("#", 1)[0] ?? "";
  const noQuery = noFragment.split("?", 1)[0] ?? "";
  return noQuery.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Pull every `href="…"` / `href='…'` target out of raw module HTML. */
function extractHtmlHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    if (m[1]) out.push(m[1]);
    m = re.exec(html);
  }
  return out;
}

/**
 * Walk a content_instance `values` blob and collect every string that
 * looks like an internal path href. Content values hold AI-authored
 * `link_href`-style targets; a plain path-shaped string is the signal.
 * Recurses into nested arrays/objects (list fields, sub-module refs).
 */
function collectValueHrefs(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (isInternalHref(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectValueHrefs(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectValueHrefs(v, out);
  }
}

/**
 * Scan every internal link in the pages visible to `chatBranchId` (its
 * branched pages + published main pages) and return the hrefs that
 * resolve to no page. Call it AFTER the branch has been merged to the
 * live tables (so it reads post-merge state), inside the same tx.
 *
 * @param tx           Active admin-DB transaction.
 * @param chatBranchId The publishing chat's branch, or null for a
 *                     main-only scan. Branched pages of this chat are
 *                     included in both the link source and the slug set.
 */
export async function scanBranchInternalLinks(
  tx: Tx,
  chatBranchId: string | null,
): Promise<LinkIntegrityResult> {
  const branchFilter = chatBranchId
    ? sql`AND (p.chat_branch_id IS NULL OR p.chat_branch_id = ${chatBranchId}::uuid)`
    : sql`AND p.chat_branch_id IS NULL`;

  // (1) The slug universe every link resolves against: pages visible
  // to the branch, plus whether a homepage exists (so `/` resolves).
  const pageRows = (await tx.execute(sql`
    SELECT DISTINCT p.slug AS slug
    FROM pages p
    WHERE p.deleted_at IS NULL ${branchFilter}
  `)) as unknown as { slug: string }[];
  const validSlugs = new Set(pageRows.map((r) => normalizePath(`/${r.slug}`)));

  const homeRows = (await tx.execute(sql`
    SELECT home_page_id::text AS home_page_id FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { home_page_id: string | null }[];
  const hasHomepage = (homeRows[0]?.home_page_id ?? null) !== null;

  // (2) One pass over placed modules: raw module HTML + the bound
  // content_instance values, for every placement on a visible page.
  const placementRows = (await tx.execute(sql`
    SELECT DISTINCT m.html AS module_html, ci."values" AS ci_values
    FROM page_modules pm
    JOIN pages p ON p.id = pm.page_id AND p.deleted_at IS NULL ${branchFilter}
    JOIN modules m ON m.id = pm.module_id AND m.deleted_at IS NULL
    JOIN content_instances ci ON ci.id = pm.content_instance_id
  `)) as unknown as { module_html: string | null; ci_values: unknown }[];

  const hrefs = new Set<string>();
  for (const row of placementRows) {
    if (typeof row.module_html === "string") {
      for (const h of extractHtmlHrefs(row.module_html)) {
        if (isInternalHref(h)) hrefs.add(h);
      }
    }
    const values = typeof row.ci_values === "string" ? safeParse(row.ci_values) : row.ci_values;
    const collected: string[] = [];
    collectValueHrefs(values, collected);
    for (const h of collected) hrefs.add(h);
  }

  /**
   * A path resolves if it's a known slug or the site root (when a
   * homepage exists). Leniency is deliberate — this warns, it doesn't
   * block, so a false positive is worse than missing an edge case
   * (CLAUDE.md §2 loud-but-honest).
   */
  const resolves = (path: string): boolean => {
    if (path === "") return hasHomepage; // bare `/`
    return validSlugs.has(path);
  };

  const broken: string[] = [];
  for (const href of hrefs) {
    if (!resolves(normalizePath(href))) broken.push(href);
  }
  broken.sort();

  return { brokenInternalLinks: broken, scannedCount: hrefs.size };
}

/** Parse a jsonb-as-text `values` column; tolerate a malformed blob. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
