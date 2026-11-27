// SPDX-License-Identifier: MPL-2.0

/**
 * #1760 — the SEO overview panel: every page with the title and meta
 * description search engines get, where each comes from (the page's own
 * text by a person or the AI, a page type or site template, inherited,
 * unset; #1752), and what the latest Stage audit found on it, with a link
 * into the editor. The human approves; this is where they see the state.
 * The data is core's (`pages_seo.overview`); the panel is data too, drawn
 * by the admin's generic renderer.
 */

import { type PluginAdminPanel, type PluginContextTier1, z } from "@caelo-cms/plugin-sdk";

/** The panel's operations. */
export const OVERVIEW_ROWS_OPERATION = "overview_rows";
export const OVERVIEW_PAGE_TYPES_OPERATION = "overview_page_types";

/** Rows per panel page. */
const PAGE_SIZE = 50;
/** Core pages read at most per panel page while filters leave none. */
const MAX_HOPS = 10;

const ORIGIN_LABELS = [
  ["unset", "Missing"],
  ["page_type", "Page type template"],
  ["site", "Site template"],
  ["inherited", "Inherited"],
  ["ai", "Written by AI"],
  ["human", "Written by a person"],
  ["reviewed", "Reviewed"],
] as const;

/** The seo plugin's finding rules the filter offers (the first: any of them). */
const FINDING_OPTIONS = [
  ["plugin.seo/", "Any SEO finding"],
  ["plugin.seo/h1-count", "Not one H1"],
  ["plugin.seo/heading-level-skipped", "Heading level skipped"],
  ["plugin.seo/image-alt-missing", "Image without alt text"],
  ["plugin.seo/link-text-generic", "Link text says nothing"],
  ["plugin.seo/placeholder-text", "Placeholder text"],
  ["plugin.seo/share-image-missing", "No share image"],
  ["plugin.seo/share-image-format", "Share image not JPEG/PNG"],
  ["plugin.seo/duplicate-title", "Duplicate title"],
  ["plugin.seo/duplicate-description", "Duplicate description"],
  ["plugin.seo/noindex-blocked", "noindex hidden by robots.txt"],
] as const;

const BADGE = {
  unset: "destructive",
  ai: "secondary",
  human: "default",
  reviewed: "default",
} as const;

/** The panel declaration. */
export const SEO_OVERVIEW_PANEL: PluginAdminPanel = {
  slug: "overview",
  title: "SEO overview",
  icon: "search",
  description:
    "Every page's title and description as search engines get them, where each comes from, and what the last Stage found.",
  permission: "content.read",
  sections: [
    {
      kind: "table",
      id: "pages",
      title: "Pages",
      description:
        'Missing values and findings first need fixing; ask the AI in the editor ("fix the SEO findings"). Templates fill titles per page type; a page\'s own text wins.',
      operation: OVERVIEW_ROWS_OPERATION,
      rowsKey: "rows",
      rowKey: "pageId",
      columns: [
        { key: "path", label: "Page", format: "code" },
        { key: "seoTitle", label: "Title", format: "text" },
        { key: "titleOrigin", label: "Title from", format: "badge", badgeVariants: BADGE },
        { key: "metaDescription", label: "Description", format: "multiline" },
        {
          key: "descriptionOrigin",
          label: "Description from",
          format: "badge",
          badgeVariants: BADGE,
        },
        { key: "indexing", label: "Indexing", format: "text" },
        { key: "findings", label: "Findings", format: "list" },
        { key: "pageId", label: "Edit", format: "page" },
      ],
      filters: [
        {
          arg: "pageType",
          label: "Page type",
          optionsOperation: OVERVIEW_PAGE_TYPES_OPERATION,
          allLabel: "All page types",
        },
        {
          arg: "origin",
          label: "Title or description from",
          allLabel: "Any origin",
          options: ORIGIN_LABELS.map(([value, label]) => ({ value, label })),
        },
        {
          arg: "finding",
          label: "Findings",
          allLabel: "All pages",
          options: FINDING_OPTIONS.map(([value, label]) => ({ value, label })),
        },
      ],
      paging: {
        pageSize: PAGE_SIZE,
        limitArg: "limit",
        cursor: { arg: "cursor", key: "cursor" },
        hasMoreKey: "hasMore",
      },
      emptyMessage: "No page matches these filters.",
    },
  ],
};

const rowsArgs = z
  .object({
    pageType: z.string().uuid().optional(),
    origin: z.enum(ORIGIN_LABELS.map(([v]) => v) as [string, ...string[]]).optional(),
    finding: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(100),
    cursor: z.string().max(600).optional(),
  })
  .strict();

const corePage = z
  .object({
    pageId: z.string(),
    path: z.string(),
    seoTitle: z.object({ value: z.string(), origin: z.string() }),
    metaDescription: z.object({ value: z.string(), origin: z.string() }),
    noindex: z.boolean(),
    canonicalUrl: z.string().nullable(),
    findings: z.array(z.object({ ruleId: z.string(), severity: z.string() }).passthrough()),
  })
  .passthrough();

const coreAnswer = z
  .object({ pages: z.array(corePage), nextCursor: z.string().nullable() })
  .strict();

/** `overview_rows`: one panel page of the overview. */
export async function overviewRows(ctx: PluginContextTier1, rawArgs: unknown) {
  if (!ctx.cms) throw new Error("seo: the cms_admin grant is missing, so pages cannot be read");
  const args = rowsArgs.parse(rawArgs);
  const rows: Record<string, unknown>[] = [];
  let cursor = args.cursor;
  let next: string | null = null;
  // Filters apply to each page core reads, so a page may come back empty
  // while more follow: read on, a bounded number of times.
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const answer = coreAnswer.parse(
      await ctx.cms.call("pages_seo.overview", {
        ...(args.pageType ? { pageTypeId: args.pageType } : {}),
        ...(args.origin ? { origin: args.origin } : {}),
        ...(args.finding ? { finding: args.finding } : {}),
        limit: args.limit,
        ...(cursor ? { cursor } : {}),
      }),
    );
    next = answer.nextCursor;
    for (const p of answer.pages) {
      rows.push({
        pageId: p.pageId,
        path: p.path,
        seoTitle: p.seoTitle.value,
        titleOrigin: p.seoTitle.origin,
        metaDescription: p.metaDescription.value,
        descriptionOrigin: p.metaDescription.origin,
        indexing: p.noindex
          ? "noindex"
          : p.canonicalUrl
            ? `canonical: ${p.canonicalUrl}`
            : "indexed",
        findings: p.findings.map((f) => f.ruleId.replace(/^plugin\.seo\//, "")),
      });
    }
    if (rows.length > 0 || next === null) break;
    cursor = next;
  }
  // The panel pages by the last row's cursor: every row carries it.
  return { rows: rows.map((r) => ({ ...r, cursor: next })), hasMore: next !== null };
}

/** `overview_page_types`: the page type filter's options, as the site has them. */
export async function overviewPageTypes(ctx: PluginContextTier1) {
  if (!ctx.cms)
    throw new Error("seo: the cms_admin grant is missing, so page types cannot be read");
  const r = z
    .object({ pageTypes: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()) })
    .passthrough()
    .parse(await ctx.cms.call("page_types.list", {}));
  return {
    options: r.pageTypes
      .slice(0, 50)
      .map((t) => ({ value: t.id, label: t.name.slice(0, 80) || "Unnamed" })),
  };
}
