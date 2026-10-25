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
 * `list-resolve` overlays are the plugin wiring's (epic #1107 part G).
 */

import {
  hasLinkResolveContributors,
  type RenderScope,
  resolveLinkVariants,
} from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ListRenderData } from "@caelo-cms/shared";
import { assembleListRenderData } from "@caelo-cms/static-generator";
import { loadPagesInView } from "./pages-view.js";
import { loadListEntities } from "./store.js";

export { ListRenderDataError } from "@caelo-cms/static-generator";

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

/** Load everything a list render needs, in one pass (see the file header). */
export async function loadListRenderData(
  tx: TransactionRunner,
  opts: LoadListRenderDataOptions,
): Promise<ListRenderData> {
  const branchId = opts.scope === "build" ? null : opts.chatBranchId;
  const pages = await loadPagesInView(tx, branchId);
  const pageVariants =
    pages.length > 0 && hasLinkResolveContributors()
      ? await resolveLinkVariants(
          pages.map((p) => p.id),
          opts.renderScope ?? { chatBranchId: branchId },
        )
      : undefined;
  return assembleListRenderData(tx, {
    listTypes: (await loadListEntities(tx, "listType", branchId)).map((t) => ({
      id: t.id,
      def: t.state.definition,
    })),
    lists: (await loadListEntities(tx, "list", branchId)).map((l) => ({
      id: l.id,
      slug: l.state.slug,
      name: l.state.name,
      listTypeId: l.state.listTypeId,
      items: l.state.items,
    })),
    pageTypes: (await loadListEntities(tx, "pageType", branchId)).map((t) => ({
      id: t.id,
      def: t.state.definition,
    })),
    pages: pages.map((p) => ({
      id: p.id,
      title: p.title,
      parentId: p.parentPageId,
      pageTypeId: p.pageTypeId,
      properties: p.properties,
      terms: p.terms,
      firstPublishedAt: p.firstPublishedAt,
      updatedAt: p.updatedAt,
      published: p.status === "published",
    })),
    ...(pageVariants ? { pageVariants } : {}),
  });
}
