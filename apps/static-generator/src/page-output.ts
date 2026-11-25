// SPDX-License-Identifier: MPL-2.0

/**
 * Page output for build observers, the generator's side (epic #1644, R1,
 * issue #1647).
 *
 * Only a full staging build (a Stage) delivers page output, and only while
 * some active plugin observes it. Per chunk the generator hashes each
 * page's final HTML (cheap), asks the plugin host which pages an observer
 * has not seen in that form, and extracts the facts of those pages only
 * (htmlparser2, a few milliseconds a page). It adds what the HTML does not
 * say: short title, page type, properties, terms, breadcrumb, the 404 flag,
 * and for every module its kind and on how many published pages it sits.
 *
 * Placement counts are counted once, before the first page: top-level
 * placements and layout chrome over the published pages the build ships.
 * A module reached only through another module's field counts on the pages
 * of its parent; the facts give it its parent's zone.
 */

import {
  type BuildPluginServices,
  type ComposedModuleRef,
  canonicalSitePath,
  extractPageHtmlFacts,
  type PageOutputFinish,
  pageHtmlHash,
} from "@caelo-cms/plugin-host";
import type { PageOutputFacts, PageOutputModule } from "@caelo-cms/plugin-sdk";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";

/** One page of a chunk, as the collector reads it. */
export interface OutputPage {
  readonly pageId: string;
  readonly html: string;
  /** The page's public path (`/de/preise/`). */
  readonly path: string;
  readonly title: string;
  readonly breadcrumbTrail: readonly string[] | null;
  readonly composed: readonly ComposedModuleRef[];
  /** Page 2+ of a paginated overview: not offered (page 1 holds the page). */
  readonly followUp: boolean;
}

interface ModuleInfo {
  readonly name: string;
  readonly kind: string | null;
  readonly count: number;
}

function jsonIds(ids: readonly string[]): SQL {
  return sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)::uuid)`;
}

/** Loads the module index of the build: names, kinds and placement counts over the published pages. */
export async function loadModuleIndex(
  tx: TransactionRunner,
  statusFilter: SQL,
): Promise<Map<string, ModuleInfo>> {
  const rows = (await tx.execute(sql`
    WITH shipped AS (
      SELECT p.id, t.layout_id FROM pages p JOIN templates t ON t.id = p.template_id
      WHERE p.deleted_at IS NULL AND p.chat_branch_id IS NULL AND t.deleted_at IS NULL ${statusFilter}
    ), placed AS (
      SELECT DISTINCT pm.module_id, pm.page_id FROM page_modules pm JOIN shipped s ON s.id = pm.page_id
      UNION
      SELECT lm.module_id, s.id FROM shipped s JOIN layout_modules lm ON lm.layout_id = s.layout_id
    ), counts AS (SELECT module_id, count(*)::int AS n FROM placed GROUP BY module_id)
    SELECT m.id::text AS id, m.display_name, m.kind, COALESCE(c.n, 0) AS n
    FROM modules m LEFT JOIN counts c ON c.module_id = m.id
    WHERE m.deleted_at IS NULL AND m.chat_branch_id IS NULL
  `)) as unknown as { id: string; display_name: string; kind: string | null; n: number }[];
  return new Map(rows.map((r) => [r.id, { name: r.display_name, kind: r.kind, count: r.n }]));
}

/**
 * On how many shipped pages each content instance shows: one placed per
 * page counts 1, a synced one (the same content everywhere) its pages.
 */
export async function loadInstanceCounts(
  tx: TransactionRunner,
  statusFilter: SQL,
): Promise<Map<string, number>> {
  const rows = (await tx.execute(sql`
    WITH shipped AS (
      SELECT p.id FROM pages p JOIN templates t ON t.id = p.template_id
      WHERE p.deleted_at IS NULL AND p.chat_branch_id IS NULL AND t.deleted_at IS NULL ${statusFilter}
    )
    SELECT pm.content_instance_id::text AS id, count(DISTINCT pm.page_id)::int AS n
    FROM page_modules pm JOIN shipped s ON s.id = pm.page_id
    WHERE pm.content_instance_id IS NOT NULL
    GROUP BY pm.content_instance_id
    HAVING count(DISTINCT pm.page_id) > 1
  `)) as unknown as { id: string; n: number }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}

interface PageMeta {
  readonly shortTitle: string | null;
  readonly pageType: string | null;
  readonly properties: Record<string, unknown>;
  readonly terms: Record<string, string[]>;
}

/** `value` as JSON with its object keys sorted, so equal data hashes equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * What an observer receives of a page, hashed: its HTML and the page data
 * the facts carry beside it (type, short title, properties, terms). A term
 * or type change that leaves the HTML alone still changes what the page
 * means to an index, so it must deliver the page again.
 */
function pageOutputHash(html: string, meta: PageMeta | undefined): string {
  return pageHtmlHash(`${html}\u0000${stableJson(meta ?? null)}`);
}

async function loadPageMeta(
  tx: TransactionRunner,
  pageIds: readonly string[],
): Promise<Map<string, PageMeta>> {
  if (pageIds.length === 0) return new Map();
  const pages = (await tx.execute(sql`
    SELECT p.id::text AS id, p.short_title, p.properties, pt.slug AS page_type
    FROM pages p LEFT JOIN page_types pt ON pt.id = p.page_type_id
    WHERE p.id IN ${jsonIds(pageIds)}
  `)) as unknown as {
    id: string;
    short_title: string | null;
    properties: unknown;
    page_type: string | null;
  }[];
  const terms = (await tx.execute(sql`
    SELECT t.page_id::text AS page_id, l.slug AS list_slug, t.item_id::text AS item_id
    FROM page_terms t JOIN lists l ON l.id = t.list_id
    WHERE t.page_id IN ${jsonIds(pageIds)}
  `)) as unknown as { page_id: string; list_slug: string; item_id: string }[];
  const termsByPage = new Map<string, Record<string, string[]>>();
  for (const t of terms) {
    const m = termsByPage.get(t.page_id) ?? termsByPage.set(t.page_id, {}).get(t.page_id);
    if (!m) continue;
    const list = m[t.list_slug] ?? [];
    list.push(t.item_id);
    m[t.list_slug] = list;
  }
  // A stable order: the meta is part of the page's output hash.
  for (const m of termsByPage.values()) for (const list of Object.values(m)) list.sort();
  const parse = (v: unknown): Record<string, unknown> =>
    typeof v === "string"
      ? (JSON.parse(v) as Record<string, unknown>)
      : ((v ?? {}) as Record<string, unknown>);
  return new Map(
    pages.map((p) => [
      p.id,
      {
        shortTitle: p.short_title,
        pageType: p.page_type,
        properties: parse(p.properties),
        terms: termsByPage.get(p.id) ?? {},
      },
    ]),
  );
}

/** Collects one Stage's page output for the observers. */
export class PageOutputCollector {
  private readonly built: string[] = [];

  private constructor(
    private readonly plugins: BuildPluginServices,
    private readonly tx: TransactionRunner,
    private readonly runId: string,
    private readonly siteBaseUrl: string,
    private readonly siteOrigins: ReadonlySet<string>,
    private readonly notFoundPageId: string | null,
    private readonly modules: Map<string, ModuleInfo>,
    private readonly instances: Map<string, number>,
    private readonly publishedPageCount: number,
    private readonly pageIdByPath: ReadonlyMap<string, string>,
  ) {}

  /** A collector when some plugin observes page output, else null. */
  static async open(args: {
    readonly plugins: BuildPluginServices;
    readonly tx: TransactionRunner;
    readonly runId: string;
    readonly siteBaseUrl: string;
    readonly siteOrigins: readonly string[];
    readonly notFoundPageId: string | null;
    readonly statusFilter: SQL;
    /** Every page the build ships, by id and public path. */
    readonly pages: readonly { readonly pageId: string; readonly path: string }[];
  }): Promise<PageOutputCollector | null> {
    if (!(await args.plugins.hasPageOutputObservers())) return null;
    const modules = await loadModuleIndex(args.tx, args.statusFilter);
    const instances = await loadInstanceCounts(args.tx, args.statusFilter);
    const byPath = new Map(args.pages.map((p) => [canonicalSitePath(p.path), p.pageId] as const));
    return new PageOutputCollector(
      args.plugins,
      args.tx,
      args.runId,
      args.siteBaseUrl,
      new Set(args.siteOrigins),
      args.notFoundPageId,
      modules,
      instances,
      args.pages.length,
      byPath,
    );
  }

  /** Offers one chunk's pages and delivers the facts the observers need. */
  async chunk(pages: readonly OutputPage[]): Promise<void> {
    const firsts = pages.filter((p) => !p.followUp);
    for (const p of firsts) this.built.push(p.pageId);
    if (firsts.length === 0) return;
    const meta = await loadPageMeta(
      this.tx,
      firsts.map((p) => p.pageId),
    );
    const hashes = new Map(
      firsts.map((p) => [p.pageId, pageOutputHash(p.html, meta.get(p.pageId))] as const),
    );
    const needed = new Set(
      await this.plugins.pageOutputNeeds(
        this.runId,
        firsts.map((p) => ({
          pageId: p.pageId,
          htmlHash: hashes.get(p.pageId) as string,
          // Keyed by what repeats: the content instance, or the module without one.
          modules: [
            ...new Map(
              p.composed.map((m) => {
                const key = m.contentInstanceId
                  ? `${m.moduleId}/${m.contentInstanceId}`
                  : m.moduleId;
                return [key, this.contentCount(m.moduleId, m.contentInstanceId)] as const;
              }),
            ),
          ],
        })),
        this.publishedPageCount,
      ),
    );
    const wanted = firsts.filter((p) => needed.has(p.pageId));
    if (wanted.length === 0) return;
    const delivered = wanted.map((p) => ({
      htmlHash: hashes.get(p.pageId) as string,
      facts: this.factsOf(p, meta.get(p.pageId)),
    }));
    for (let i = 0; i < delivered.length; i += 200)
      await this.plugins.observePageOutputs(this.runId, delivered.slice(i, i + 200));
  }

  /** On how many pages a placement shows the same content (its instance's, else its module's). */
  private contentCount(moduleId: string, instanceId: string | null): number {
    if (instanceId) return this.instances.get(instanceId) ?? 1;
    return this.modules.get(moduleId)?.count ?? 0;
  }

  private factsOf(page: OutputPage, meta: PageMeta | undefined): PageOutputFacts {
    const url = new URL(page.path, this.siteBaseUrl).toString();
    const html = extractPageHtmlFacts({
      pageId: page.pageId,
      path: page.path,
      url,
      html: page.html,
      composed: page.composed,
      siteOrigins: this.siteOrigins,
    });
    const modules: PageOutputModule[] = html.modules.map((m) => {
      const info = this.modules.get(m.moduleId);
      return {
        moduleId: m.moduleId,
        name: info?.name ?? m.moduleId,
        kind: info?.kind ?? null,
        zone: m.zone,
        contentInstanceId: m.contentInstanceId,
        placementCount: info?.count ?? 0,
        contentPlacementCount: this.contentCount(m.moduleId, m.contentInstanceId),
      };
    });
    // The digest covers everything an observer reads, so a changed short
    // title or placement count re-delivers the page.
    const body = {
      pageId: page.pageId,
      url,
      path: page.path,
      lang: html.lang ?? "",
      title: html.title ?? page.title,
      shortTitle: meta?.shortTitle ?? null,
      metaDescription: html.metaDescription,
      pageType: meta?.pageType ?? null,
      properties: meta?.properties ?? {},
      terms: meta?.terms ?? {},
      breadcrumb: [...(page.breadcrumbTrail ?? [])],
      noindex: (html.robots ?? "").includes("noindex"),
      notFoundPage: page.pageId === this.notFoundPageId,
      hasDeferredContent: html.hasDeferredContent,
      truncated: html.truncated,
      modules,
      texts: html.texts,
      links: html.links.map((l) => ({
        ...l,
        targetPageId: l.path === null ? null : (this.pageIdByPath.get(l.path) ?? null),
      })),
    };
    return { ...body, outputHash: pageHtmlHash(JSON.stringify(body)) };
  }

  /** The end of the build: what the observers learn about the whole site. */
  async finish(): Promise<PageOutputFinish> {
    const counts = [...this.modules.entries()]
      .filter(([, m]) => m.count > 0)
      .map(([id, m]) => [id, m.count] as [string, number]);
    return this.plugins.finishPageOutput(this.runId, this.built, counts);
  }
}
