// SPDX-License-Identifier: MPL-2.0

/**
 * Lists in a deploy build (epic #1107, `docs/lists.md` §10): the build's
 * list render data and its render dependencies.
 *
 * The generator runs outside admin-core (subprocess), so — like the link
 * index (`link-index.ts`) — it loads the main-line, published state
 * itself; admin-core's `lists/load.ts` is the draft-aware twin for the
 * editor preview. Both feed the same shared resolver
 * (`createListRenderContext`), which is what keeps preview and build HTML
 * equal.
 *
 * Render dependencies: every built page's {@link ListRenderDeps} are
 * merged into `render-deps.json`, written into the build directory (the
 * build manifest's place) and next to the target's builds
 * (`<outDir>/render-deps.json`), where the next incremental build of the
 * target reads them to find the pages a change reaches.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BuildPluginServices,
  mergeListOverlays,
  type ResolvedListOverlays,
} from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type LinkPageVariant,
  type ListItem,
  type ListMediaRecord,
  type ListPageRecord,
  type ListRenderData,
  type ListRenderDeps,
  type ListTypeDef,
  type LoadedList,
  type LoadedListType,
  type LoadedPageType,
  mergeRenderDeps,
  type PageTypeDef,
  parseRenderDeps,
  RENDER_DEPS_FILE,
  type RenderDepsFile,
  renderDepsAttrs,
  selectDependentPages,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/** One list type / list / page type, as the assembler takes them. */
export interface ListSourceType<D> {
  readonly id: string;
  readonly def: D;
}

/** One page with its type-bound state, in the scope being rendered. */
export interface ListSourcePage {
  readonly id: string;
  readonly title: string;
  readonly shortTitle: string;
  readonly parentId: string | null;
  readonly pageTypeId: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly terms: readonly string[];
  readonly firstPublishedAt: string | null;
  readonly updatedAt: string;
  /** Published in this scope: a query may return it. */
  readonly published: boolean;
}

/** The scope-dependent rows a list render is assembled from. */
export interface ListRenderSources {
  readonly listTypes: readonly ListSourceType<ListTypeDef>[];
  readonly lists: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly listTypeId: string;
    readonly items: readonly ListItem[];
  }[];
  readonly pageTypes: readonly ListSourceType<PageTypeDef>[];
  readonly pages: readonly ListSourcePage[];
  /** The `link-resolve` partition — the same answer the link index got. */
  readonly pageVariants?: ReadonlyMap<string, LinkPageVariant>;
  /** The `list-resolve` answers per plugin (epic #1107 part G). */
  readonly overlaySources?: ResolvedListOverlays;
  /**
   * The editor preview renders a site whose language is not set yet (it
   * flags `site-language-unset` itself): dates then format for `und`, the
   * BCP 47 "undetermined" tag. A build refuses instead.
   */
  readonly languageUnset: "refuse" | "undetermined";
}

/**
 * `ListRenderData` plus where its overlays came from, so the caller can
 * hand the entries the render refused to the plugin that sent them
 * (`reportListOverlayIssues`).
 */
export interface LoadedListRenderData extends ListRenderData {
  readonly overlaySources?: ResolvedListOverlays;
}

/**
 * The output variants of a render: the distinct variants of the
 * `link-resolve` partition, sorted (the `list-resolve` point is asked for
 * exactly these).
 */
export function renderVariants(
  pageVariants: ReadonlyMap<string, LinkPageVariant> | undefined,
): string[] {
  if (!pageVariants) return [];
  return [...new Set([...pageVariants.values()].map((v) => v.variant))].sort();
}

/** The thrown error when the site language is unset (builds refuse to run without it). */
export class ListRenderDataError extends Error {
  override readonly name = "ListRenderDataError";
}

/**
 * The scope-independent rows a list render reads: every page's SEO
 * summary and social image, every media asset's metadata, the site
 * language and home page. Read once by {@link loadListRenderBase}; the
 * editor preview keeps them in its cached site view (#1212).
 */
export interface ListRenderBase {
  readonly seo: readonly {
    readonly page_id: string;
    readonly meta_description: string;
    readonly og_image: string | null;
  }[];
  readonly media: readonly {
    readonly id: string;
    readonly alt: string;
    readonly width: number | null;
    readonly height: number | null;
  }[];
  readonly siteLanguage: string | null;
  readonly homePageId: string | null;
}

/** Read the {@link ListRenderBase} (three queries). */
export async function loadListRenderBase(tx: TransactionRunner): Promise<ListRenderBase> {
  const seo = (await tx.execute(sql`
    SELECT page_id::text AS page_id, meta_description, og_image_asset_id::text AS og_image
    FROM pages_seo
  `)) as unknown as ListRenderBase["seo"][number][];
  const media = (await tx.execute(sql`
    SELECT id::text AS id, alt, width, height FROM media_assets WHERE deleted_at IS NULL
  `)) as unknown as ListRenderBase["media"][number][];
  const lang = (await tx.execute(sql`
    SELECT site_language, home_page_id::text AS home_page_id FROM site_defaults WHERE id = 1
  `)) as unknown as { site_language: string | null; home_page_id: string | null }[];
  return {
    seo,
    media,
    siteLanguage: lang[0]?.site_language ?? null,
    homePageId: lang[0]?.home_page_id ?? null,
  };
}

/**
 * Assemble `ListRenderData` from scope-dependent rows plus the
 * scope-independent ones (SEO summaries / social images, media metadata,
 * the site language). Shared by the build loader below and admin-core's
 * draft-aware preview loader (`lists/load.ts`), so the two produce the
 * same shape from their own views.
 */
export async function assembleListRenderData(
  tx: TransactionRunner,
  src: ListRenderSources,
): Promise<LoadedListRenderData> {
  return assembleListRenderDataFrom(src, await loadListRenderBase(tx));
}

/** {@link assembleListRenderData} once the {@link ListRenderBase} is loaded (pure). */
export function assembleListRenderDataFrom(
  src: ListRenderSources,
  base: ListRenderBase,
): LoadedListRenderData {
  const listTypes = new Map<string, LoadedListType>();
  const typeSlugById = new Map<string, string>();
  for (const t of src.listTypes) {
    listTypes.set(t.def.slug, { id: t.id, def: t.def });
    typeSlugById.set(t.id, t.def.slug);
  }
  const lists = new Map<string, LoadedList>();
  for (const l of src.lists) {
    lists.set(l.id, {
      id: l.id,
      slug: l.slug,
      name: l.name,
      // A deleted type under a list cannot happen through the ops (the
      // delete is refused while lists use it); should the data say
      // otherwise, the id makes the resolver report `list-type-missing`.
      typeSlug: typeSlugById.get(l.listTypeId) ?? l.listTypeId,
      items: l.items,
    });
  }
  const pageTypes = new Map<string, LoadedPageType>();
  const pageTypeSlugById = new Map<string, string>();
  for (const t of src.pageTypes) {
    pageTypes.set(t.def.slug, { id: t.id, def: t.def });
    pageTypeSlugById.set(t.id, t.def.slug);
  }

  const seoByPage = new Map(base.seo.map((r) => [r.page_id, r]));
  const pages = new Map<string, ListPageRecord>();
  for (const p of src.pages) {
    const s = seoByPage.get(p.id);
    pages.set(p.id, {
      id: p.id,
      title: p.title,
      shortTitle: p.shortTitle,
      parentId: p.parentId,
      pageTypeSlug: pageTypeSlugById.get(p.pageTypeId) ?? p.pageTypeId,
      properties: p.properties,
      terms: p.terms,
      firstPublishedAt: p.firstPublishedAt,
      updatedAt: p.updatedAt,
      summary: s && s.meta_description.trim() !== "" ? s.meta_description : null,
      image: s?.og_image ? `caelo:media/${s.og_image}` : null,
      inBuild: p.published,
    });
  }

  const media = new Map<string, ListMediaRecord>();
  for (const m of base.media) {
    media.set(m.id, {
      id: m.id,
      alt: m.alt.trim() === "" ? null : m.alt,
      width: m.width,
      height: m.height,
    });
  }

  const siteLanguage = base.siteLanguage;
  if (siteLanguage === null && src.languageUnset === "refuse") {
    throw new ListRenderDataError(
      "site_defaults.site_language is not set — set the site language (set_site_identity siteLanguage) before lists can render",
    );
  }
  return {
    listTypes,
    lists,
    pageTypes,
    pages,
    media,
    siteLanguage: siteLanguage ?? "und",
    homePageId: base.homePageId,
    ...(src.pageVariants ? { pageVariants: src.pageVariants } : {}),
    ...(src.overlaySources && src.overlaySources.plugins.length > 0
      ? { overlays: mergeListOverlays(src.overlaySources), overlaySources: src.overlaySources }
      : {}),
  };
}

function json<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

/**
 * Load the list render data of a build: list types, lists, page types and
 * pages of the MAIN line (a chat's branch never ships; published =
 * `inBuild`), media metadata and the `link-resolve` page partition asked
 * of the same plugin services the link index asks, and the `list-resolve`
 * overlays of that partition's variants.
 */
export async function loadBuildListRenderData(
  tx: TransactionRunner,
  opts: {
    readonly env: "dev" | "staging" | "production";
    readonly plugins: BuildPluginServices;
    /** First-publication time of published pages that were never live (see generateSite). */
    readonly publishAt: string;
  },
): Promise<LoadedListRenderData> {
  const live = sql`chat_branch_id IS NULL AND deleted_at IS NULL`;
  const listTypes = (await tx.execute(sql`
    SELECT id::text AS id, definition FROM list_types
    WHERE ${live} AND plugin_list_type_available(plugin_id) ORDER BY slug
  `)) as unknown as { id: string; definition: unknown }[];
  const lists = (await tx.execute(sql`
    SELECT id::text AS id, slug, name, list_type_id::text AS list_type_id, items
    FROM lists WHERE ${live} ORDER BY slug
  `)) as unknown as {
    id: string;
    slug: string;
    name: string;
    list_type_id: string;
    items: unknown;
  }[];
  const pageTypes = (await tx.execute(sql`
    SELECT id::text AS id, definition FROM page_types WHERE ${live} ORDER BY slug
  `)) as unknown as { id: string; definition: unknown }[];
  const pages = (await tx.execute(sql`
    SELECT p.id::text AS id, p.title, p.short_title, p.parent_page_id::text AS parent_id,
           p.page_type_id::text AS page_type_id, p.properties, p.status,
           p.first_published_at, p.updated_at,
           COALESCE((
             SELECT array_agg('caelo:term/' || pt.list_id::text || '/' || pt.item_id::text
                              ORDER BY pt.created_at, pt.list_id, pt.item_id)
             FROM page_terms pt WHERE pt.page_id = p.id
           ), '{}') AS terms
    FROM pages p WHERE p.chat_branch_id IS NULL AND p.deleted_at IS NULL
  `)) as unknown as {
    id: string;
    title: string;
    short_title: string;
    parent_id: string | null;
    page_type_id: string;
    properties: unknown;
    status: string;
    first_published_at: string | Date | null;
    updated_at: string | Date;
    terms: string[];
  }[];
  const iso = (v: string | Date | null): string | null =>
    v === null ? null : v instanceof Date ? v.toISOString() : String(v);
  const pageVariants =
    pages.length > 0 && (await opts.plugins.hasLinkResolveContributors())
      ? await opts.plugins.resolveLinkVariants(pages.map((p) => p.id))
      : undefined;
  const variants = renderVariants(pageVariants);
  const overlaySources =
    variants.length > 0 && (await opts.plugins.hasListResolveContributors())
      ? await opts.plugins.resolveListOverlays(variants)
      : undefined;
  return assembleListRenderData(tx, {
    listTypes: listTypes.map((t) => ({ id: t.id, def: json<ListTypeDef>(t.definition) })),
    lists: lists.map((l) => ({
      id: l.id,
      slug: l.slug,
      name: l.name,
      listTypeId: l.list_type_id,
      items: json<ListItem[]>(l.items),
    })),
    pageTypes: pageTypes.map((t) => ({ id: t.id, def: json<PageTypeDef>(t.definition) })),
    pages: pages.map((p) => ({
      id: p.id,
      title: p.title,
      shortTitle: p.short_title,
      parentId: p.parent_id,
      pageTypeId: p.page_type_id,
      properties: json<Record<string, unknown>>(p.properties) ?? {},
      terms: p.terms,
      // A published page this build ships for the first time carries the
      // instant Publish live will store for it.
      firstPublishedAt:
        iso(p.first_published_at) ?? (p.status === "published" ? opts.publishAt : null),
      updatedAt: iso(p.updated_at) ?? "",
      published: p.status === "published",
    })),
    ...(pageVariants ? { pageVariants } : {}),
    ...(overlaySources ? { overlaySources } : {}),
    languageUnset: "refuse",
  });
}

/** What changed since the target's last build, as the redeploy trigger reports it. */
export interface BuildChange {
  readonly pageIds: readonly string[];
  readonly listIds: readonly string[];
  readonly listTypeIds: readonly string[];
}

/** True when the build is incremental (anything named as changed). */
export function isIncremental(change: BuildChange): boolean {
  return change.pageIds.length + change.listIds.length + change.listTypeIds.length > 0;
}

/** The target-level deps file (the last build's view), or null. */
export async function readTargetRenderDeps(outDir: string): Promise<RenderDepsFile | null> {
  let raw: string | null = null;
  try {
    raw = await readFile(join(outDir, RENDER_DEPS_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return parseRenderDeps(raw);
}

/**
 * The pages an incremental build renders: the changed pages plus every
 * page whose recorded deps intersect the change.
 *
 * Without a deps file (the target's builds predate render deps)
 * dependents cannot be known: a change that names pages renders exactly
 * those, as incremental builds always did, and the build writes the deps
 * the next one reads; a change that names only lists or list types has
 * nothing to narrow it and renders every page.
 *
 * @returns the page ids, or null for "every page".
 */
export function incrementalPageIds(
  change: BuildChange,
  deps: RenderDepsFile | null,
  data: ListRenderData,
): string[] | null {
  if (deps === null) return change.pageIds.length > 0 ? [...change.pageIds] : null;
  const typeSlugs: string[] = [];
  for (const t of data.listTypes.values()) {
    if (change.listTypeIds.includes(t.id)) typeSlugs.push(t.def.slug);
  }
  const current = new Map([...data.pages.values()].map((p) => [p.id, renderDepsAttrs(p)]));
  const dependents = selectDependentPages(
    deps,
    { pageIds: change.pageIds, listIds: change.listIds, listTypeSlugs: typeSlugs },
    current,
  );
  return [...new Set([...change.pageIds, ...dependents])];
}

/**
 * Merge this build's per-page deps into the target's file and write it to
 * the build directory and the target directory.
 */
export async function writeRenderDeps(args: {
  readonly outDir: string;
  readonly buildDir: string;
  readonly previous: RenderDepsFile | null;
  readonly rebuilt: ReadonlyMap<string, ListRenderDeps>;
  readonly data: ListRenderData;
  /** A full build replaces the previous file instead of merging into it. */
  readonly full: boolean;
}): Promise<void> {
  const merged = mergeRenderDeps(
    args.full ? null : args.previous,
    args.rebuilt,
    args.data.pages.values(),
  );
  const json = JSON.stringify(merged);
  await writeFile(join(args.buildDir, RENDER_DEPS_FILE), json, "utf8");
  await writeFile(join(args.outDir, RENDER_DEPS_FILE), json, "utf8");
}
