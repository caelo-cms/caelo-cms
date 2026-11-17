// SPDX-License-Identifier: MPL-2.0

/**
 * What one chat's draft changes mean for the site, in the words an
 * operator uses: pages that are new, changed or removed, and parts that
 * show on many pages. The Live Edit "Draft changes" panel and Content →
 * Changes show these counts per conversation, and the rows behind
 * "Show details".
 *
 * The change refs (`loadPendingChangesFor`) list one entry per changed
 * entity, so one page with eight edited sections is eight content refs
 * plus its page and section refs. A summary counts the page once and says
 * in one phrase what changed on it. Rule-based on purpose: the same draft
 * reads the same everywhere, and it costs no AI call.
 */

import { z } from "zod";
import type { PendingChanges } from "./stage.js";

/** One row behind "Show details": a page, or one part that shows on many pages. */
export const draftSummaryRowSchema = z
  .object({
    /** `page:<id>`, or `<kind>:<id>` of a site-wide part. */
    key: z.string(),
    area: z.enum(["page", "siteWide"]),
    change: z.enum(["new", "changed", "removed"]),
    /** The page title, or the part's name. */
    title: z.string(),
    /** The page path; null for a site-wide part or a page without one. */
    path: z.string().nullable(),
    /** What changed, e.g. "Text and images, sections" or "List". */
    what: z.string(),
    /** The page, for opening it in the preview; null for a site-wide part. */
    pageId: z.string().nullable(),
  })
  .strict();

/** A row of {@link draftSummarySchema}. */
export type DraftSummaryRow = z.infer<typeof draftSummaryRowSchema>;

/** The counts a conversation shows, and its detail rows (pages first). */
export const draftSummarySchema = z
  .object({
    newPages: z.number().int().nonnegative(),
    changedPages: z.number().int().nonnegative(),
    removedPages: z.number().int().nonnegative(),
    /** Parts that show on many pages: section designs, templates, the layout, lists, the theme. */
    siteWide: z.number().int().nonnegative(),
    rows: z.array(draftSummaryRowSchema),
  })
  .strict();

/** The summary of one chat's draft changes. */
export type DraftSummary = z.infer<typeof draftSummarySchema>;

type Ref = PendingChanges["pending"]["pages"][number];

/**
 * What a site-wide part is called for the operator, by change kind. The
 * Publish live review (deploy.publish_preview) names its parts the same way.
 */
export const SITE_WIDE_WHAT: Readonly<Record<string, string>> = {
  module: "Section design",
  template: "Page template",
  layout: "Site layout",
  theme: "Colours and fonts",
  list: "List",
  listType: "List type",
  pageType: "Page type",
  contentInstance: "Shared content",
  pluginRow: "Plugin data",
};

/** Site-wide kinds in the order the details list them. */
const SITE_WIDE_ORDER = Object.keys(SITE_WIDE_WHAT);

/** What changed on a page, in a fixed order: content, sections, then the page's own fields. */
function pageWhat(kinds: ReadonlySet<string>, seo: boolean): string {
  const parts: string[] = [];
  if (kinds.has("pageModuleContent")) parts.push("Text and images");
  if (kinds.has("pageLayout")) parts.push("Sections");
  if (kinds.has("page")) parts.push(seo ? "Search result text" : "Page settings");
  const [first, ...rest] = parts;
  if (first === undefined) return "Changed";
  return [first, ...rest.map((p) => p.toLowerCase())].join(", ");
}

/** A layout chrome ref names its block (`block=header`): "Header". */
function layoutTitle(ref: Ref): string {
  const block = /^block=(.+)$/.exec(ref.detail ?? "")?.[1];
  if (!block) return "Site layout";
  return block.charAt(0).toUpperCase() + block.slice(1).replace(/[-_]/g, " ");
}

/** A plugin row's label is `<plugin> · <table>`: the plugin names it. */
function siteWideTitle(ref: Ref): string {
  if (ref.kind === "layout") return layoutTitle(ref);
  if (ref.kind === "pluginRow") return ref.label.split(" · ")[0] ?? ref.label;
  return ref.label;
}

/**
 * Summarize one chat's change refs: pending and (on an isolated branch)
 * marked-staged refs alike, since both are not on staging yet.
 */
export function summarizeDraftChanges(changes: PendingChanges): DraftSummary {
  const refs = [changes.pending, changes.staged].flatMap((g) => [
    ...g.pages,
    ...g.globals,
    ...g.lists,
  ]);

  interface PageAcc {
    title: string;
    path: string | null;
    kinds: Set<string>;
    seo: boolean;
    change: Ref["change"] | undefined;
  }
  const pages = new Map<string, PageAcc>();
  const siteWide = new Map<string, DraftSummaryRow & { order: number }>();

  for (const ref of refs) {
    if (ref.kind === "page" || ref.kind === "pageLayout" || ref.kind === "pageModuleContent") {
      const pageId = ref.pageId ?? ref.entityId;
      const acc = pages.get(pageId) ?? {
        title: ref.label,
        path: ref.pagePath ?? null,
        kinds: new Set<string>(),
        seo: false,
        change: undefined,
      };
      acc.kinds.add(ref.kind);
      if (ref.kind === "page") {
        acc.change = ref.change;
        acc.seo = ref.seo === true;
        acc.title = ref.label;
      }
      acc.path ??= ref.pagePath ?? null;
      pages.set(pageId, acc);
      continue;
    }
    const what = SITE_WIDE_WHAT[ref.kind];
    if (what === undefined) {
      // A new change kind without a name here is a bug to fix in this table,
      // never a row that silently drops out of the operator's view.
      throw new Error(`summarizeDraftChanges: no site-wide name for change kind '${ref.kind}'`);
    }
    const key = `${ref.kind}:${ref.entityId}`;
    if (siteWide.has(key)) continue;
    siteWide.set(key, {
      key,
      area: "siteWide",
      change: "changed",
      title: siteWideTitle(ref),
      path: null,
      what,
      pageId: null,
      order: SITE_WIDE_ORDER.indexOf(ref.kind),
    });
  }

  const pageRows: DraftSummaryRow[] = [];
  let newPages = 0;
  let changedPages = 0;
  let removedPages = 0;
  for (const [pageId, p] of pages) {
    // Made and deleted again in the draft: nothing of it reaches the site.
    if (p.change === "createdAndDeleted") continue;
    const change = p.change === "created" ? "new" : p.change === "deleted" ? "removed" : "changed";
    if (change === "new") newPages += 1;
    else if (change === "removed") removedPages += 1;
    else changedPages += 1;
    pageRows.push({
      key: `page:${pageId}`,
      area: "page",
      change,
      title: p.title,
      path: p.path,
      what: change === "new" ? "New page" : change === "removed" ? "Removed" : pageWhat(p.kinds, p.seo),
      pageId,
    });
  }
  const rank = { new: 0, changed: 1, removed: 2 } as const;
  pageRows.sort(
    (a, b) =>
      rank[a.change] - rank[b.change] ||
      (a.path ?? "").localeCompare(b.path ?? "") ||
      a.title.localeCompare(b.title),
  );
  const siteRows = [...siteWide.values()]
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map(({ order: _order, ...row }) => row);

  return {
    newPages,
    changedPages,
    removedPages,
    siteWide: siteRows.length,
    rows: [...pageRows, ...siteRows],
  };
}
