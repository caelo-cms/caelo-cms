// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — the batch load behind every list render (docs/lists.md §10):
 * list types, shared lists, page types, the page index page queries and
 * system sources read, media metadata and the site language, as ONE
 * `ListRenderData` per preview or per build. Everything after this is
 * pure and synchronous (`createListRenderContext` in the shared resolver),
 * the same split as the link index.
 *
 *   - `scope: "preview"` reads the caller's draft view: live rows plus the
 *     chat branch's pending changes (`chatBranchId`; null = main);
 *   - `scope: "build"` reads the published state: main rows only, the
 *     branch is ignored.
 *
 * A page is `inBuild` when its status (in that view) is published — what
 * a query may return. `pageVariants` and `overlays` (the `link-resolve` /
 * `list-resolve` plugin answers) are filled by the plugin wiring, not here.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type {
  LinkRenderEnv,
  ListMediaRecord,
  ListPageRecord,
  ListRenderData,
  LoadedList,
  LoadedListType,
  LoadedPageType,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { loadPagesInView } from "./pages-view.js";
import { loadListEntities } from "./store.js";

/** The site has no language set; dates cannot be formatted and builds refuse to run. */
export class ListRenderDataError extends Error {
  override readonly name = "ListRenderDataError";
}

export interface LoadListRenderDataOptions {
  readonly chatBranchId: string | null;
  readonly scope: "preview" | "build";
  /**
   * Where the render goes. Part of the loader contract (docs/lists.md §10)
   * so preview and generator call it alike; `inBuild` is "published in
   * this view" in every environment, so nothing here branches on it.
   */
  readonly env: LinkRenderEnv;
}

/** Load everything a list render needs, in one pass (see the file header). */
export async function loadListRenderData(
  tx: TransactionRunner,
  opts: LoadListRenderDataOptions,
): Promise<ListRenderData> {
  const branchId = opts.scope === "build" ? null : opts.chatBranchId;

  const listTypes = new Map<string, LoadedListType>();
  const typeSlugById = new Map<string, string>();
  for (const t of await loadListEntities(tx, "listType", branchId)) {
    listTypes.set(t.state.slug, { id: t.id, def: t.state.definition });
    typeSlugById.set(t.id, t.state.slug);
  }

  const lists = new Map<string, LoadedList>();
  for (const l of await loadListEntities(tx, "list", branchId)) {
    lists.set(l.id, {
      id: l.id,
      slug: l.state.slug,
      name: l.state.name,
      // A type deleted under a list cannot happen through the ops (the
      // delete is refused while lists use it); should the data say
      // otherwise, the id makes the resolver report `list-type-missing`
      // loudly instead of rendering with a guessed type.
      typeSlug: typeSlugById.get(l.state.listTypeId) ?? l.state.listTypeId,
      items: l.state.items,
    });
  }

  const pageTypes = new Map<string, LoadedPageType>();
  const pageTypeSlugById = new Map<string, string>();
  for (const t of await loadListEntities(tx, "pageType", branchId)) {
    pageTypes.set(t.state.slug, { id: t.id, def: t.state.definition });
    pageTypeSlugById.set(t.id, t.state.slug);
  }

  const seo = (await tx.execute(sql`
    SELECT page_id::text AS page_id, meta_description, og_image_asset_id::text AS og_image
    FROM pages_seo
  `)) as unknown as { page_id: string; meta_description: string; og_image: string | null }[];
  const seoByPage = new Map(seo.map((s) => [s.page_id, s]));

  const pages = new Map<string, ListPageRecord>();
  for (const p of await loadPagesInView(tx, branchId)) {
    const s = seoByPage.get(p.id);
    pages.set(p.id, {
      id: p.id,
      title: p.title,
      parentId: p.parentPageId,
      pageTypeSlug: pageTypeSlugById.get(p.pageTypeId) ?? p.pageTypeId,
      properties: p.properties,
      terms: p.terms,
      firstPublishedAt: p.firstPublishedAt,
      updatedAt: p.updatedAt,
      summary: s && s.meta_description.trim() !== "" ? s.meta_description : null,
      image: s?.og_image ? `caelo:media/${s.og_image}` : null,
      inBuild: p.status === "published",
    });
  }

  const media = new Map<string, ListMediaRecord>();
  const mediaRows = (await tx.execute(sql`
    SELECT id::text AS id, alt, width, height FROM media_assets WHERE deleted_at IS NULL
  `)) as unknown as { id: string; alt: string; width: number | null; height: number | null }[];
  for (const m of mediaRows) {
    media.set(m.id, {
      id: m.id,
      alt: m.alt.trim() === "" ? null : m.alt,
      width: m.width,
      height: m.height,
    });
  }

  const lang = (await tx.execute(sql`
    SELECT site_language FROM site_defaults WHERE id = 1
  `)) as unknown as { site_language: string | null }[];
  const siteLanguage = lang[0]?.site_language ?? null;
  if (siteLanguage === null) {
    throw new ListRenderDataError(
      "site_defaults.site_language is not set — set the site language (set_site_identity siteLanguage) before lists can render dates",
    );
  }

  return { listTypes, lists, pageTypes, pages, media, siteLanguage };
}
