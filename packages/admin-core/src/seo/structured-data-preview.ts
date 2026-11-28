// SPDX-License-Identifier: MPL-2.0

/**
 * #1753 — what plugins add to the previewed page's JSON-LD graph, asked
 * exactly as the build asks (apps/static-generator/src/structured-data-pass.ts)
 * but in the editor's view: the page and the pages it names as the chat's
 * branch shows them, published pages only among the named ones. The
 * preview then builds the graph with the build's builder, so the two write
 * the same nodes for the same data.
 */

import {
  type CollectedStructuredData,
  collectStructuredData,
  hasStructuredDataContributors,
  type PublicUrlContext,
  type RenderScope,
} from "@caelo-cms/plugin-host";
import type {
  StructuredDataArgs,
  StructuredDataPage,
  StructuredDataTerm,
} from "@caelo-cms/plugin-sdk";
import type { ReadScope } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  type ListItem,
  MEDIA_PLACEHOLDER_KEY,
  propertyTermRefs,
} from "@caelo-cms/shared";
import { loadListEntities } from "../lists/store.js";
import { listPagesOp } from "../ops/content/pages.js";
import { loadShareImageUrls } from "./share-image.js";

/** What the preview knows of the page as it renders it. */
export interface PreviewStructuredDataPage {
  readonly pageId: string;
  readonly lang: string;
  readonly description: string;
  readonly shareImage: string | null;
  readonly live: boolean;
  readonly listed: readonly string[];
}

/** A page's tags and the terms its `term` properties name, by page id. */
interface PageTerms {
  readonly tags: Map<string, StructuredDataTerm[]>;
  readonly props: Map<string, StructuredDataTerm[]>;
}

/** The plugins' parts of the previewed page, and the preview URLs of the images they name. */
export interface PreviewStructuredData {
  readonly collected: CollectedStructuredData;
  readonly mediaUrl: (assetId: string) => string | null;
}

interface PageRow {
  readonly id: string;
  readonly currentPath: string;
  readonly title: string;
  readonly shortTitle: string;
  readonly pageType: string;
  readonly properties: Record<string, unknown>;
  readonly terms: string[];
  readonly firstPublishedAt: string | null;
  readonly status: "draft" | "published";
}

const PAGE_REF_RE = /^caelo:page\/([0-9a-f-]{36})/i;
const TERM_REF_RE = /^caelo:term\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i;

function flatten(
  items: readonly ListItem[],
  out = new Map<string, ListItem>(),
): Map<string, ListItem> {
  for (const i of items) {
    out.set(i.id, i);
    flatten(i.children ?? [], out);
  }
  return out;
}

function mediaIn(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) for (const v of value) mediaIn(v, out);
  else if (typeof value === "object" && value !== null) {
    const id = (value as Record<string, unknown>)[MEDIA_PLACEHOLDER_KEY];
    if (typeof id === "string") out.add(id);
    else for (const v of Object.values(value)) mediaIn(v, out);
  }
}

/**
 * Ask the contributing plugins about the previewed page; null when none
 * contributes (nothing is read then).
 *
 * @param pageTypeProperties the property definitions of a page type by slug (the site view).
 */
export async function previewStructuredData(args: {
  readonly ctx: ExecutionContext;
  readonly reads: ReadScope;
  readonly page: PreviewStructuredDataPage;
  readonly pageTypeProperties: (slug: string) => StructuredDataArgs["pageTypes"][string] | null;
  readonly site: StructuredDataArgs["site"];
  readonly scope: PublicUrlContext & RenderScope;
}): Promise<PreviewStructuredData | null> {
  if (!hasStructuredDataContributors()) return null;
  const { ctx, reads } = args;
  const branchId = ctx.chatBranchId ?? null;
  const pagesOf = (ids: readonly string[]) =>
    ids.length === 0
      ? Promise.resolve([] as PageRow[])
      : reads.read(async (tx) => {
          const r = await listPagesOp.handler(
            ctx,
            { includeDeleted: false, pageIds: [...ids] },
            tx,
          );
          if (!r.ok) throw new Error(`structured data: reading pages failed: ${r.error.kind}`);
          return r.value.pages as unknown as PageRow[];
        });
  // A page's tags and the terms its `term` properties name, resolved alike
  // with one list read (as the build does).
  type Ref = { pageId: string; listId: string; itemId: string; prop: boolean };
  const termsOf = async (rows: readonly PageRow[]): Promise<PageTerms> => {
    const refs: Ref[] = rows.flatMap((r) => [
      ...r.terms.flatMap((t) => {
        const m = TERM_REF_RE.exec(t);
        return m
          ? [
              {
                pageId: r.id,
                listId: (m[1] as string).toLowerCase(),
                itemId: (m[2] as string).toLowerCase(),
                prop: false,
              },
            ]
          : [];
      }),
      ...propertyTermRefs(r.properties).map((t) => ({
        pageId: r.id,
        listId: t.listId.toLowerCase(),
        itemId: t.itemId.toLowerCase(),
        prop: true,
      })),
    ]);
    const out: PageTerms = { tags: new Map(), props: new Map() };
    const listIds = [...new Set(refs.map((r) => r.listId))];
    if (listIds.length === 0) return out;
    const lists = await reads.read((tx) =>
      loadListEntities(tx, "list", branchId, { ids: listIds }),
    );
    const items = new Map(
      lists.map((l) => [l.id, { slug: l.state.slug, items: flatten(l.state.items) }]),
    );
    for (const r of refs) {
      const list = items.get(r.listId);
      const item = list?.items.get(r.itemId);
      if (!list || !item) continue;
      const href = (item.values.landing_page as { href?: unknown } | undefined)?.href;
      const landing = typeof href === "string" ? PAGE_REF_RE.exec(href) : null;
      const into = r.prop ? out.props : out.tags;
      into.set(r.pageId, [
        ...(into.get(r.pageId) ?? []),
        {
          vocabulary: list.slug,
          listId: r.listId,
          itemId: r.itemId,
          name: typeof item.values.name === "string" ? item.values.name : "",
          slug: typeof item.values.slug === "string" ? item.values.slug : "",
          overviewPageId: landing ? (landing[1] as string).toLowerCase() : null,
        },
      ]);
    }
    return out;
  };
  const record = (
    r: PageRow,
    terms: PageTerms,
    own: PreviewStructuredDataPage | null,
  ): StructuredDataPage => ({
    pageId: r.id,
    pageType: r.pageType,
    path: r.currentPath,
    isHome: r.currentPath === "/",
    lang: own?.lang ?? "",
    title: r.title,
    shortTitle: r.shortTitle,
    description: own?.description ?? "",
    shareImage: own?.shareImage ?? null,
    live: own?.live ?? false,
    publishedAt: r.firstPublishedAt,
    properties: r.properties,
    terms: terms.tags.get(r.id) ?? [],
    propertyTerms: terms.props.get(r.id) ?? [],
    listed: own?.listed ?? [],
  });

  const [row] = await pagesOf([args.page.pageId]);
  if (!row) return null;
  const ownTerms = await termsOf([row]);
  const page = record(row, ownTerms, args.page);
  const named = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      const m = PAGE_REF_RE.exec(v);
      if (m) named.add((m[1] as string).toLowerCase());
    } else if (Array.isArray(v)) for (const e of v) visit(e);
  };
  for (const v of Object.values(page.properties)) visit(v);
  for (const t of page.terms) if (t.overviewPageId) named.add(t.overviewPageId);
  named.delete(page.pageId);
  // A draft author is left out, as on the page.
  const relatedRows = (await pagesOf([...named])).filter((r) => r.status === "published");
  const relatedTerms = await termsOf(relatedRows);
  const related = relatedRows.map((r) => record(r, relatedTerms, null));
  const pageTypes: Record<string, StructuredDataArgs["pageTypes"][string]> = {};
  for (const p of [page, ...related]) {
    const def = args.pageTypeProperties(p.pageType);
    if (def) pageTypes[p.pageType] = def;
  }
  const collected = await collectStructuredData(
    { pages: [page], related, pageTypes, site: args.site },
    args.scope,
  );
  const wanted = new Set<string>();
  for (const parts of collected.parts.values()) mediaIn(parts, wanted);
  const urls = await reads.read((tx) => loadShareImageUrls(tx, [...wanted]));
  return { collected, mediaUrl: (id) => urls.get(id) ?? null };
}
