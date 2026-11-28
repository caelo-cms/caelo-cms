// SPDX-License-Identifier: MPL-2.0

/**
 * The seo plugin's index of the published site (#1759): per page its path,
 * title, page type, terms and the pages its content links to, kept from
 * core's page output at every Stage (the `page_output` observer, #1647).
 *
 * It is what the topic and link tools read: how many published articles
 * carry a term, which pages link to a page, how many clicks a page is from
 * the home page. It describes what the site publishes, not drafts, which
 * is what those numbers are about. Derived state, rebuilt from the source:
 * a new plugin version or settings digest makes core deliver every page
 * again, and the observer writes only rows that changed.
 *
 * Links in the layout (menus, footers) are left out: they link every page
 * from every page and would drown what the content says about a page.
 */

import type {
  PageOutputFacts,
  PageOutputObserverArgs,
  PluginContextTier1,
} from "@caelo-cms/plugin-sdk";

type Ctx = PluginContextTier1;

/** The plugin's table of published pages (its `adminSchema`). */
export const PAGE_INDEX_TABLE = "page_index";

/** Content links kept per page: enough for every page an article links to. */
export const MAX_LINKS_PER_PAGE = 200;

/** Rows read or written per store call. */
const STORE_CHUNK = 1000;

/** One row of {@link PAGE_INDEX_TABLE}. */
export interface PageIndexRow {
  readonly id: string;
  readonly page_id: string;
  readonly path: string;
  readonly title: string;
  readonly page_type: string;
  /** Vocabulary slug → term item ids. */
  readonly terms: Readonly<Record<string, readonly string[]>>;
  /** Page ids the page's content links to, each once. */
  readonly links: readonly string[];
  /** Listed by search engines: not noindex, not the 404 page. */
  readonly indexable: boolean;
}

/** What a row holds of a page, before it has an id. */
export type PageIndexValues = Omit<PageIndexRow, "id">;

function adminQueryOf(ctx: Ctx) {
  if (!ctx.adminQuery)
    throw new Error("seo: its private storage grant (cms_admin_schema) is missing");
  return ctx.adminQuery;
}

/** A page's row values from its facts. */
export function rowOfFacts(f: PageOutputFacts): PageIndexValues {
  const links: string[] = [];
  for (const l of f.links) {
    if (l.zone === "layout" || l.targetPageId === null || l.targetPageId === f.pageId) continue;
    if (!links.includes(l.targetPageId)) links.push(l.targetPageId);
    if (links.length >= MAX_LINKS_PER_PAGE) break;
  }
  return {
    page_id: f.pageId,
    path: f.path,
    title: f.title,
    page_type: f.pageType ?? "",
    terms: f.terms,
    links,
    indexable: !f.noindex && !f.notFoundPage,
  };
}

/** Whether a stored row already says what `values` says. */
function same(row: PageIndexRow, values: PageIndexValues): boolean {
  return (
    row.path === values.path &&
    row.title === values.title &&
    row.page_type === values.page_type &&
    row.indexable === values.indexable &&
    JSON.stringify(row.terms) === JSON.stringify(values.terms) &&
    JSON.stringify(row.links) === JSON.stringify(values.links)
  );
}

/** The stored rows of these pages (pages the last Stage did not publish are absent). */
export async function rowsOf(ctx: Ctx, pageIds: readonly string[]): Promise<PageIndexRow[]> {
  const q = adminQueryOf(ctx);
  const out: PageIndexRow[] = [];
  for (let at = 0; at < pageIds.length; at += STORE_CHUNK) {
    out.push(
      ...(await q.list<typeof PAGE_INDEX_TABLE, PageIndexRow>(PAGE_INDEX_TABLE, {
        anyOf: { page_id: pageIds.slice(at, at + STORE_CHUNK) },
        limit: STORE_CHUNK,
      })),
    );
  }
  return out;
}

/**
 * The page-output observer: write the delivered pages' rows (only those
 * that changed) and, on the Stage's last call, drop the pages it no
 * longer ships.
 */
export async function observePageOutput(ctx: Ctx, args: PageOutputObserverArgs): Promise<void> {
  const q = adminQueryOf(ctx);
  const stored = new Map(
    (
      await rowsOf(
        ctx,
        args.pages.map((p) => p.pageId),
      )
    ).map((r) => [r.page_id, r]),
  );
  for (const f of args.pages) {
    const values = rowOfFacts(f);
    const row = stored.get(f.pageId);
    if (!row) await q.insert(PAGE_INDEX_TABLE, values);
    else if (!same(row, values)) await q.update(PAGE_INDEX_TABLE, row.id, values);
  }
  if (args.final && args.removed.length > 0) {
    for (const row of await rowsOf(ctx, args.removed)) await q.delete(PAGE_INDEX_TABLE, row.id);
  }
}

/** Most rows the tools read: past it they say so instead of answering on part of the site. */
export const MAX_INDEXED_PAGES = 50_000;

/** Every indexed page, in pages of {@link STORE_CHUNK}. Loud past {@link MAX_INDEXED_PAGES}. */
export async function allIndexedPages(ctx: Ctx): Promise<PageIndexRow[]> {
  const q = adminQueryOf(ctx);
  const out: PageIndexRow[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await q.list<typeof PAGE_INDEX_TABLE, PageIndexRow>(PAGE_INDEX_TABLE, {
      orderBy: "id",
      orderDir: "asc",
      limit: STORE_CHUNK,
      ...(afterId ? { afterId } : {}),
    });
    out.push(...page);
    if (page.length < STORE_CHUNK) return out;
    if (out.length >= MAX_INDEXED_PAGES) {
      throw new Error(
        `seo: the site has more than ${MAX_INDEXED_PAGES} published pages; topic and link suggestions read at most that many`,
      );
    }
    afterId = (page[page.length - 1] as PageIndexRow).id;
  }
}
