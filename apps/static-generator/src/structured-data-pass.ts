// SPDX-License-Identifier: MPL-2.0

/**
 * #1753, #1756, #1761 — what the plugins add to a build's structured data:
 * per page batch, the page records the `structured_data` and
 * `sitemap_entries` composition points are asked with, the plugins'
 * checked answers, and the library images they name, published with the
 * build. The SEO pass builds each page's one JSON-LD graph from them
 * (shared `json-ld.ts`) and the news and video sitemaps.
 *
 * The records come from what the page shows or core owns: its page type
 * and properties, terms with their overview pages, title, meta description,
 * share image, whether it is in the live record, and the pages its lists
 * show. The pages its `page` properties name (authors, a reviewer) and its
 * terms' overview pages are related records, one level deep, published
 * pages only: a draft author is left out, as on the page.
 *
 * Without a contributing plugin nothing is loaded and nobody is asked.
 */

import type {
  BuildPluginServices,
  CollectedSitemapEntries,
  ResolvedVideoEntry,
} from "@caelo-cms/plugin-host";
import {
  SITEMAP_KIND_FILES,
  type StructuredDataArgs,
  type StructuredDataPage,
  type StructuredDataPropertyDef,
  type StructuredDataTerm,
} from "@caelo-cms/plugin-sdk";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type GraphContribution,
  MEDIA_PLACEHOLDER_KEY,
  type NewsSitemapEntry,
  type PageUrlStyle,
  renderNewsSitemap,
  renderVideoSitemap,
  type VideoSitemapEntry,
  type VideoSitemapVideo,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { MediaPass } from "./media-pass.js";
import type { RenderFailure } from "./nested-modules-pass.js";

/** What the SEO pass knows of one page of a batch, resolved as the page renders it. */
export interface StructuredDataBatchPage {
  readonly pageId: string;
  readonly lang: string;
  /** The meta description the page renders. */
  readonly description: string;
  /** The share image the page shows, or null. */
  readonly shareImage: string | null;
  /** In the live record: it carries live dates. */
  readonly live: boolean;
  /** The pages its page queries showed. */
  readonly listed: readonly string[];
}

/** The plugins' parts of one batch, checked. */
export interface BatchStructuredData {
  readonly parts: ReadonlyMap<string, GraphContribution[]>;
  readonly sitemap: CollectedSitemapEntries | null;
  /** pageId → `plugin-value-refused` markers. */
  readonly refused: ReadonlyMap<string, readonly string[]>;
  /** The published URL of every library image the parts and entries name; null = not publishable. */
  readonly mediaUrl: (assetId: string) => string | null;
}

/** The structured-data side of the SEO pass. */
export interface StructuredDataPass {
  forBatch(pages: readonly StructuredDataBatchPage[]): Promise<BatchStructuredData>;
}

interface RecordRow {
  id: string;
  current_path: string;
  title: string;
  short_title: string;
  properties: unknown;
  first_published_at: Date | string | null;
  page_type: string;
  type_properties: unknown;
}

function jsonIds(ids: readonly string[]) {
  return sql`(SELECT jsonb_array_elements_text((${JSON.stringify(ids)}::text)::jsonb)::uuid)`;
}

const parse = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));
const PAGE_REF_RE = /^caelo:page\/([0-9a-f-]{36})/i;

/** The pages `properties` and `terms` name: page references and overview pages. */
function namedPageIds(
  properties: Record<string, unknown>,
  terms: readonly StructuredDataTerm[],
): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      const m = PAGE_REF_RE.exec(v);
      if (m) out.add((m[1] as string).toLowerCase());
    } else if (Array.isArray(v)) for (const e of v) visit(e);
  };
  for (const v of Object.values(properties)) visit(v);
  for (const t of terms) if (t.overviewPageId) out.add(t.overviewPageId);
  return [...out];
}

interface ListItemRow {
  readonly id: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly children?: readonly ListItemRow[];
}

/** The terms of these pages, with their vocabulary's slug and each term's overview page. */
async function termsOf(
  tx: TransactionRunner,
  pageIds: readonly string[],
): Promise<Map<string, StructuredDataTerm[]>> {
  const out = new Map<string, StructuredDataTerm[]>();
  if (pageIds.length === 0) return out;
  const rows = (await tx.execute(sql`
    SELECT t.page_id::text AS page_id, t.list_id::text AS list_id, t.item_id::text AS item_id
      FROM page_terms t WHERE t.page_id IN ${jsonIds(pageIds)}
     ORDER BY t.created_at, t.list_id, t.item_id
  `)) as unknown as { page_id: string; list_id: string; item_id: string }[];
  const listIds = [...new Set(rows.map((r) => r.list_id))];
  if (listIds.length === 0) return out;
  const lists = (await tx.execute(sql`
    SELECT id::text AS id, slug, items FROM lists
     WHERE id IN ${jsonIds(listIds)} AND chat_branch_id IS NULL AND deleted_at IS NULL
  `)) as unknown as { id: string; slug: string; items: unknown }[];
  const items = new Map<string, { slug: string; item: ListItemRow }>();
  const flatten = (listId: string, slug: string, entries: readonly ListItemRow[]) => {
    for (const e of entries) {
      items.set(`${listId}/${e.id}`, { slug, item: e });
      flatten(listId, slug, e.children ?? []);
    }
  };
  for (const l of lists) flatten(l.id, l.slug, (parse(l.items) as ListItemRow[]) ?? []);
  for (const r of rows) {
    const found = items.get(`${r.list_id}/${r.item_id}`);
    if (!found) continue;
    const values = found.item.values ?? {};
    const href = (values.landing_page as { href?: unknown } | undefined)?.href;
    const landing = typeof href === "string" ? PAGE_REF_RE.exec(href) : null;
    const list = out.get(r.page_id) ?? [];
    list.push({
      vocabulary: found.slug,
      listId: r.list_id,
      itemId: r.item_id,
      name: typeof values.name === "string" ? values.name : "",
      slug: typeof values.slug === "string" ? values.slug : "",
      overviewPageId: landing ? (landing[1] as string).toLowerCase() : null,
    });
    out.set(r.page_id, list);
  }
  return out;
}

/** The records of these pages (published only when `publishedOnly`). */
async function recordRows(
  tx: TransactionRunner,
  pageIds: readonly string[],
  publishedOnly: boolean,
): Promise<RecordRow[]> {
  if (pageIds.length === 0) return [];
  return (await tx.execute(sql`
    SELECT p.id::text AS id, p.current_path, p.title, p.short_title, p.properties,
           p.first_published_at, pt.slug AS page_type, pt.definition->'properties' AS type_properties
      FROM pages p
      JOIN page_types pt ON pt.id = p.page_type_id
     WHERE p.id IN ${jsonIds(pageIds)} AND p.deleted_at IS NULL
       ${publishedOnly ? sql`AND p.status = 'published'` : sql``}
  `)) as unknown as RecordRow[];
}

/** The page types of the records, by slug (property definitions only). */
function pageTypesOf(rows: readonly RecordRow[]): StructuredDataArgs["pageTypes"] {
  const out: Record<string, { properties: StructuredDataPropertyDef[] }> = {};
  for (const r of rows) {
    if (out[r.page_type]) continue;
    const defs =
      (parse(r.type_properties) as { name: string; type: string; multiple?: boolean }[]) ?? [];
    out[r.page_type] = {
      properties: defs.map((d) => ({
        name: d.name,
        type: d.type,
        ...(d.multiple !== undefined ? { multiple: d.multiple } : {}),
      })),
    };
  }
  return out;
}

/** Every `$caeloMedia` id a part names. */
function mediaIn(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) for (const v of value) mediaIn(v, out);
  else if (typeof value === "object" && value !== null) {
    const id = (value as Record<string, unknown>)[MEDIA_PLACEHOLDER_KEY];
    if (typeof id === "string") out.add(id);
    else for (const v of Object.values(value)) mediaIn(v, out);
  }
}

/**
 * The structured-data side of one build's SEO pass, or null when no running
 * plugin contributes structured data or sitemap entries.
 */
export async function prepareStructuredDataPass(args: {
  readonly tx: TransactionRunner;
  readonly plugins: BuildPluginServices;
  readonly media: MediaPass;
  readonly siteBaseUrl: string;
  readonly pageUrlStyle: PageUrlStyle;
  readonly site: StructuredDataArgs["site"];
  /**
   * When this build publishes (the live comparison's `publishAt`): a page it
   * records live for the first time has no `first_published_at` yet, and
   * goes live with this date, as its graph and sitemap dates do.
   */
  readonly publishAt: string;
}): Promise<StructuredDataPass | null> {
  const [graph, sitemaps] = await Promise.all([
    args.plugins.hasStructuredDataContributors(),
    args.plugins.hasSitemapEntriesContributors(),
  ]);
  if (!graph && !sitemaps) return null;
  const urlContext = { siteBaseUrl: args.siteBaseUrl, pageUrlStyle: args.pageUrlStyle };
  const base = args.siteBaseUrl.replace(/\/$/, "");
  const mediaUrls = new Map<string, string | null>();

  return {
    async forBatch(batch) {
      const ids = batch.map((p) => p.pageId);
      const [rows, terms] = await Promise.all([
        recordRows(args.tx, ids, false),
        termsOf(args.tx, ids),
      ]);
      const byId = new Map(batch.map((p) => [p.pageId, p]));
      const toRecord = (
        r: RecordRow,
        own: StructuredDataBatchPage | undefined,
      ): StructuredDataPage => ({
        pageId: r.id,
        pageType: r.page_type,
        path: r.current_path,
        isHome: r.current_path === "/",
        lang: own?.lang ?? "",
        title: r.title,
        shortTitle: r.short_title,
        // A related page carries no head of its own here (as in the preview).
        description: own ? own.description : "",
        shareImage: own ? own.shareImage : null,
        live: own?.live ?? false,
        publishedAt:
          r.first_published_at !== null
            ? iso(r.first_published_at)
            : own?.live
              ? args.publishAt
              : null,
        properties: (parse(r.properties) as Record<string, unknown>) ?? {},
        terms: terms.get(r.id) ?? [],
        listed: own?.listed ?? [],
      });
      const pages = rows.map((r) => toRecord(r, byId.get(r.id)));
      const relatedIds = [
        ...new Set(pages.flatMap((p) => namedPageIds(p.properties, p.terms))),
      ].filter((id) => !byId.has(id));
      const relatedRows = await recordRows(args.tx, relatedIds, true);
      const relatedTerms = await termsOf(
        args.tx,
        relatedRows.map((r) => r.id),
      );
      const related = relatedRows.map((r) => ({
        ...toRecord(r, undefined),
        terms: relatedTerms.get(r.id) ?? [],
      }));
      const input: StructuredDataArgs = {
        pages,
        related,
        pageTypes: pageTypesOf([...rows, ...relatedRows]),
        site: args.site,
      };
      const [collected, sitemap] = await Promise.all([
        graph ? args.plugins.collectStructuredData(input, urlContext) : null,
        sitemaps ? args.plugins.collectSitemapEntries(input, urlContext) : null,
      ]);
      // Every library image the answers name, published with the build.
      const wanted = new Set<string>();
      for (const parts of collected?.parts.values() ?? []) mediaIn(parts, wanted);
      for (const videos of sitemap?.videos.values() ?? [])
        for (const v of videos) wanted.add(v.thumbnail);
      for (const id of wanted) {
        if (mediaUrls.has(id)) continue;
        const outcome = await args.media.publishOgImage(id);
        mediaUrls.set(id, outcome.kind === "published" ? `${base}/${outcome.path}` : null);
      }
      const refused = new Map<string, string[]>();
      for (const source of [collected?.refused, sitemap?.refused]) {
        for (const [pageId, markers] of source ?? []) {
          refused.set(pageId, [...(refused.get(pageId) ?? []), ...markers]);
        }
      }
      return {
        parts: collected?.parts ?? new Map(),
        sitemap,
        refused,
        mediaUrl: (id) => mediaUrls.get(id) ?? null,
      };
    },
  };
}

/** The page a render failure names. */
interface FailurePage {
  readonly pageId: string;
  readonly slug: string;
  readonly title: string;
  readonly currentPath: string;
}

/** A refused structured-data part (or sitemap entry) as a render failure of its page. */
export function structuredDataRenderFailure(b: FailurePage, marker: string): RenderFailure {
  return {
    pageId: b.pageId,
    pageTitle: b.title,
    pagePath: b.currentPath,
    blockName: null,
    moduleSlug: null,
    field: null,
    reason: marker,
    target: null,
    line: `page "${b.slug}": structured data (${marker})`,
  };
}

/** What one page of the live record lists in the news and video sitemaps. */
export interface ExtraSitemapPage {
  readonly loc: string;
  readonly language: string;
  readonly publishedAt: string;
  readonly news: { readonly title: string } | undefined;
  readonly videos: readonly ResolvedVideoEntry[] | undefined;
  readonly mediaUrl: (assetId: string) => string | null;
}

/** The news and video sitemaps of one build, collected batch by batch. */
export class ExtraSitemaps {
  readonly #news: NewsSitemapEntry[] = [];
  readonly #videos: VideoSitemapEntry[] = [];

  /** @param siteName the publication's name (`sitemap-entries` refuses news without one). */
  constructor(private readonly siteName: string | null) {}

  /** Add one page's entries. */
  add(b: FailurePage, page: ExtraSitemapPage): void {
    if (page.news && this.siteName !== null) {
      this.#news.push({
        loc: page.loc,
        title: page.news.title,
        publicationName: this.siteName,
        language: page.language,
        publicationDate: page.publishedAt,
      });
    }
    const videos: VideoSitemapVideo[] = [];
    for (const v of page.videos ?? []) {
      const thumbnailLoc = page.mediaUrl(v.thumbnail);
      // The host let only library images through (`sitemap-entries`): one
      // the media pass cannot publish has no file, which no edit repairs.
      if (thumbnailLoc === null) {
        throw new Error(
          `static-generator: page "${b.slug}": the video thumbnail ${v.thumbnail} is a library image without a stored file`,
        );
      }
      videos.push({
        thumbnailLoc,
        title: v.title,
        description: v.description,
        ...(v.contentUrl ? { contentLoc: v.contentUrl } : {}),
        ...(v.playerUrl ? { playerLoc: v.playerUrl } : {}),
        ...(v.durationSeconds !== undefined ? { durationSeconds: v.durationSeconds } : {}),
        publicationDate: page.publishedAt,
      });
    }
    if (videos.length > 0) this.#videos.push({ loc: page.loc, videos });
  }

  /** Write the sitemaps that have entries; returns their files. */
  async write(write: (relPath: string, content: string) => Promise<void>): Promise<string[]> {
    const files: string[] = [];
    if (this.#news.length > 0) {
      await write(SITEMAP_KIND_FILES.news, renderNewsSitemap(this.#news));
      files.push(SITEMAP_KIND_FILES.news);
    }
    if (this.#videos.length > 0) {
      await write(SITEMAP_KIND_FILES.video, renderVideoSitemap(this.#videos));
      files.push(SITEMAP_KIND_FILES.video);
    }
    return files;
  }
}
