// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — the batch load behind every list render in the editor
 * preview (docs/lists.md §10): list types, shared lists, page types and
 * the page index of the caller's DRAFT view (live rows plus the chat
 * branch's pending changes; null = main), media metadata, the site
 * language and the `link-resolve` page partition, as one
 * `ListRenderData`. Everything after this is pure and synchronous
 * (`createListRenderContext` in the shared resolver).
 *
 * The build has its twin in the generator (`apps/static-generator`
 * `list-data.ts`, main line only — the generator runs as a subprocess and
 * cannot import admin-core); both feed `assembleListRenderData`, so
 * preview and build see the same shape. `scope: "build"` here reads the
 * main line the same way, for callers inside admin-core.
 *
 * A page is `inBuild` when its status (in that view) is published. The
 * `list-resolve` overlays are asked for the partition's variants in the
 * same render scope, so a chat's preview shows the chat's translations.
 *
 * Three steps (#1212), so the editor preview can hold no transaction while
 * plugins answer: the rows (the preview's cached site view, or
 * {@link loadListRenderData}'s own reads), the plugin answers
 * ({@link resolveListPluginInputs}), and the pure assembly
 * ({@link listRenderDataOf}).
 *
 * The editor preview renders one page, so it asks `list-resolve` for that
 * page only (#1223): the partition first ({@link resolveLinkPartition}),
 * the assembly without overlays, then the page's variant with what the
 * page can show ({@link resolvePageListOverlays}, `./overlay-scope.ts`),
 * applied with `withListOverlays`.
 */

import {
  hasLinkResolveContributors,
  hasListResolveContributors,
  type RenderScope,
  type ResolvedLinkVariants,
  type ResolvedListOverlays,
  resolveLinkVariants,
  resolveListOverlays,
} from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  assembleListRenderData,
  assembleListRenderDataFrom,
  type ListRenderBase,
  type ListRenderSources,
  type LoadedListRenderData,
  renderVariants,
} from "@caelo-cms/static-generator";
import type { SiteView } from "../site-view.js";
import type { ListOverlayScope } from "./overlay-scope.js";
import { loadPagesInView, type PageInView } from "./pages-view.js";
import { type ListEntityView, loadListEntities } from "./store.js";

/** Options of {@link loadListRenderData}. */
export interface LoadListRenderDataOptions {
  /** The chat branch whose draft view a preview renders; null = main line. */
  readonly chatBranchId: string | null;
  readonly scope: "preview" | "build";
  /**
   * Where the render goes. Part of the loader contract so preview and
   * generator call it alike; `inBuild` is "published in this view" in
   * every environment, so nothing here branches on it.
   */
  readonly env: "preview" | "dev" | "staging" | "production";
  /**
   * The render's plugin scope (the preview's failure sink), so the
   * `link-resolve` partition is asked exactly like the link index asks
   * it. Defaults to the branch scope without a sink.
   */
  readonly renderScope?: RenderScope;
}

/** What the plugins contribute to a list render. */
export interface ListPluginInputs {
  /** The `link-resolve` partition of the asked pages. */
  readonly pageVariants?: ResolvedLinkVariants;
  /** The `list-resolve` overlays of the partition's variants. */
  readonly overlaySources?: ResolvedListOverlays;
}

/**
 * Ask the plugins for the `link-resolve` partition of `pageIds` and the
 * `list-resolve` overlays of its variants. Costs nothing when no plugin
 * contributes. Call it with no transaction held: each plugin answer can
 * take connections of its own (#1209).
 */
export async function resolveListPluginInputs(
  pageIds: readonly string[],
  scope: RenderScope,
): Promise<ListPluginInputs> {
  const pageVariants = await resolveLinkPartition(pageIds, scope);
  const variants = renderVariants(pageVariants);
  const overlaySources =
    variants.length > 0 && hasListResolveContributors()
      ? await resolveListOverlays(variants, scope)
      : undefined;
  return {
    ...(pageVariants ? { pageVariants } : {}),
    ...(overlaySources ? { overlaySources } : {}),
  };
}

/**
 * The `link-resolve` partition of `pageIds`; undefined when no plugin
 * contributes (or no page is asked). Call it with no transaction held.
 */
export async function resolveLinkPartition(
  pageIds: readonly string[],
  scope: RenderScope,
): Promise<ResolvedLinkVariants | undefined> {
  return pageIds.length > 0 && hasLinkResolveContributors()
    ? await resolveLinkVariants(pageIds, scope)
    : undefined;
}

/**
 * #1223 — the `list-resolve` overlays one editor preview page needs: its
 * own variant only, scoped to what the page can show from lists
 * (`pageListOverlayScope`). Undefined — and no plugin is asked — when the
 * page has no variant in the partition, shows nothing a list overlay can
 * change (`scope` null), or no plugin contributes. Call it with no
 * transaction held.
 */
export async function resolvePageListOverlays(
  variant: string | undefined,
  pageScope: ListOverlayScope | null,
  scope: RenderScope,
): Promise<ResolvedListOverlays | undefined> {
  if (variant === undefined || pageScope === null || !hasListResolveContributors()) {
    return undefined;
  }
  return resolveListOverlays([variant], scope, pageScope);
}

/** The scope-dependent rows of a list render. */
interface ListRows {
  readonly listTypes: readonly ListEntityView<"listType">[];
  readonly lists: readonly ListEntityView<"list">[];
  readonly pageTypes: readonly ListEntityView<"pageType">[];
  readonly pages: readonly PageInView[];
}

function listSourcesOf(
  rows: ListRows,
  plugins: ListPluginInputs,
  opts: { readonly previewPublishAt: string; readonly languageUnset: "refuse" | "undetermined" },
): ListRenderSources {
  return {
    listTypes: rows.listTypes.map((t) => ({ id: t.id, def: t.state.definition })),
    lists: rows.lists.map((l) => ({
      id: l.id,
      slug: l.state.slug,
      name: l.state.name,
      listTypeId: l.state.listTypeId,
      items: l.state.items,
    })),
    pageTypes: rows.pageTypes.map((t) => ({ id: t.id, def: t.state.definition })),
    pages: rows.pages.map((p) => ({
      id: p.id,
      title: p.title,
      shortTitle: p.shortTitle,
      parentId: p.parentPageId,
      pageTypeId: p.pageTypeId,
      properties: p.properties,
      terms: p.terms,
      // A published page that was never live shows as if it went live now —
      // where the next Publish live puts it in "latest news" (#1121 review).
      firstPublishedAt:
        p.firstPublishedAt ?? (p.status === "published" ? opts.previewPublishAt : null),
      updatedAt: p.updatedAt,
      published: p.status === "published",
    })),
    ...(plugins.pageVariants ? { pageVariants: plugins.pageVariants } : {}),
    ...(plugins.overlaySources ? { overlaySources: plugins.overlaySources } : {}),
    languageUnset: opts.languageUnset,
  };
}

/**
 * The editor preview's list render data from its site view and the
 * plugin answers (pure). Same result as {@link loadListRenderData} with
 * `scope: "preview"` over the same rows.
 */
export function listRenderDataOf(view: SiteView, plugins: ListPluginInputs): LoadedListRenderData {
  return assembleListRenderDataFrom(
    listSourcesOf(view, plugins, {
      previewPublishAt: new Date().toISOString(),
      languageUnset: "undetermined",
    }),
    view.listBase satisfies ListRenderBase,
  );
}

/** Load everything a list render needs, in one pass (see the file header). */
export async function loadListRenderData(
  tx: TransactionRunner,
  opts: LoadListRenderDataOptions,
): Promise<LoadedListRenderData> {
  const branchId = opts.scope === "build" ? null : opts.chatBranchId;
  const pages = await loadPagesInView(tx, branchId);
  const previewPublishAt = new Date().toISOString();
  const plugins = await resolveListPluginInputs(
    pages.map((p) => p.id),
    opts.renderScope ?? { chatBranchId: branchId },
  );
  const rows: ListRows = {
    listTypes: await loadListEntities(tx, "listType", branchId),
    lists: await loadListEntities(tx, "list", branchId),
    pageTypes: await loadListEntities(tx, "pageType", branchId),
    pages,
  };
  return assembleListRenderData(
    tx,
    listSourcesOf(rows, plugins, {
      previewPublishAt,
      languageUnset: opts.scope === "preview" ? "undetermined" : "refuse",
    }),
  );
}
