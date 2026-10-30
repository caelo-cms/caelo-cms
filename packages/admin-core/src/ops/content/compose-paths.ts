// SPDX-License-Identifier: MPL-2.0

/**
 * #390 / epic #690 — THE path composition over a page tree: ancestor
 * chain from the tree, plugin contributions from their annotations, the
 * composition grammar from plugin-host.
 *
 * Split out of `current-path.ts` (which persists composed paths and runs
 * the move side effects) so read-only consumers — the branch page view
 * the link index and the link canonicaliser use (epic #724) — can
 * compose paths without importing the move machinery, which reaches the
 * module write ops and would close an import cycle.
 */

import {
  collectUrlAnnotations,
  type RenderScope,
  resolvePageUrl,
  type UrlCompositionView,
} from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { type ExecutionContext, isHomeSlug } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { ancestorSlugsOf, type PageTree, type PageTreeNode } from "./page-tree.js";

/**
 * Home predicate for PATH COMPOSITION: an explicit designation wins
 * outright — magic slugs ("", home, index) act as the root only when NO
 * designation exists. (isDesignatedHomePage's OR-shape is right for
 * "should this render as the root?" consumers, but composing paths with
 * it would let a magic-slug page and a designated page both claim "/",
 * violating the current_path uniqueness the whole point rests on.)
 *
 * A nested page (one with a parent) is never a root: the move ops refuse
 * to give the homepage a parent, and a magic slug below a parent is just
 * a segment ("/docs/index").
 */
function isCompositionHome(
  pageId: string,
  slug: string,
  hasParent: boolean,
  designatedHomePageId: string | null,
  annotations: Record<string, unknown>,
): boolean {
  if (hasParent) return false;
  // A URL plugin may declare this page the root of its own URL space.
  // The site has ONE designated home, but a multilingual site has one
  // per locale, and core cannot derive the others — it has no locale
  // concept (epic #380). The `international-site` plugin answers it
  // from the variant group; without this the German home composes to
  // `/de/<slug>` instead of `/de/`.
  //
  // Uniqueness still holds: each locale root carries a different path
  // prefix, so `/` and `/de` never collide.
  if (annotations.isLocaleRoot === true) return true;
  if (designatedHomePageId !== null) return pageId === designatedHomePageId;
  return isHomeSlug(slug);
}

/**
 * The page core composes at "/" in `tree` — the root half of
 * {@link isCompositionHome} without plugin annotations: the designated
 * home when one is set, else the top-level magic-slug page. Null when
 * the site has neither. `site_defaults.get` reports it as `rootPageId`
 * so readers (URL plugins deciding which page's counterparts are locale
 * roots) never re-derive the rule from the designation alone.
 */
export function compositionRootPageId(
  tree: PageTree,
  designatedHomePageId: string | null,
): string | null {
  if (designatedHomePageId !== null) return designatedHomePageId;
  for (const node of tree.byId.values()) {
    if (isCompositionHome(node.id, node.slug, node.parentPageId !== null, null, {})) {
      return node.id;
    }
  }
  return null;
}

async function loadDesignatedHomePageId(tx: TransactionRunner): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT home_page_id::text AS home_page_id FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { home_page_id: string | null }[];
  return rows[0]?.home_page_id ?? null;
}

/** One render id per (operation transaction, branch) — see {@link renderScopeOf}. */
const writeRenderIds = new WeakMap<TransactionRunner, Map<string, string>>();

/**
 * The render scope a write runs in: its chat branch, or main — with a
 * render id that lives exactly as long as the operation's transaction
 * (#1254). An op composes paths several times (pages.duplicate plans the
 * move, then recomputes the copy's path); with one id the URL plugins
 * read their locale registry and variant groups once per op instead of
 * once per composition. Plugin data does not change inside such an op, so
 * the memo cannot go stale; a merge, which replays plugin rows between
 * compositions, builds its scopes without an id on purpose.
 */
export function renderScopeOf(ctx: ExecutionContext, tx: TransactionRunner): RenderScope {
  const chatBranchId = ctx.chatBranchId ?? null;
  let ids = writeRenderIds.get(tx);
  if (ids === undefined) {
    ids = new Map();
    writeRenderIds.set(tx, ids);
  }
  const key = chatBranchId ?? "main";
  let renderId = ids.get(key);
  if (renderId === undefined) {
    renderId = crypto.randomUUID();
    ids.set(key, renderId);
  }
  return { chatBranchId, renderId };
}

/** One composed page: its path, and whether it is a URL-space root. */
export interface ComposedPath {
  readonly path: string;
  /** True for the site home and plugin-declared roots (a locale home):
   *  such a page serves at its prefix root and can neither have nor be
   *  a parent. */
  readonly isRoot: boolean;
}

/**
 * Compose the public path of each given page from `tree` — THE core
 * path computation (ancestor chain from the tree, plugin contributions
 * from their annotations, the composition grammar from plugin-host).
 * Every other path computation in core goes through here.
 *
 * @param annotationScope whose plugin state annotates the pages (main or
 *   a chat branch); independent of the tree's scope so a merge can pair
 *   the post-replay tree with the branch's plugin view.
 * @param view which plugin contributions take part (default: all active).
 */
export async function composePathsDetailed(
  tx: TransactionRunner,
  tree: PageTree,
  pageIds: ReadonlyArray<string>,
  annotationScope: RenderScope,
  view?: UrlCompositionView,
): Promise<Map<string, ComposedPath>> {
  const ids = composableIds(tree, pageIds);
  if (ids.length === 0) return new Map();
  const designated = await loadDesignatedHomePageId(tx);
  const annotations = await collectUrlAnnotations(ids, annotationScope, view);
  return composePathsFrom(tree, ids, designated, annotations, view);
}

/** The distinct ids of `pageIds` that are pages of `tree`, in order. */
function composableIds(tree: PageTree, pageIds: ReadonlyArray<string>): string[] {
  return [...new Set(pageIds)].filter((id) => tree.byId.has(id));
}

/**
 * Issue #1212 — {@link composePaths} for a caller that holds no
 * transaction: the designated home page is already known (the preview's
 * site view carries it), and the plugin annotations are asked here, with
 * no database connection held while the plugins answer.
 */
export async function composePathsOutsideTransaction(
  tree: PageTree,
  pageIds: ReadonlyArray<string>,
  designatedHomePageId: string | null,
  annotationScope: RenderScope,
): Promise<Map<string, string>> {
  const ids = composableIds(tree, pageIds);
  if (ids.length === 0) return new Map();
  const annotations = await collectUrlAnnotations(ids, annotationScope);
  const detailed = composePathsFrom(tree, ids, designatedHomePageId, annotations);
  return new Map([...detailed].map(([id, c]) => [id, c.path]));
}

/** The pure core of the path composition, once the inputs are loaded. */
function composePathsFrom(
  tree: PageTree,
  ids: readonly string[],
  designated: string | null,
  annotations: ReadonlyMap<string, Record<string, unknown>>,
  view?: UrlCompositionView,
): Map<string, ComposedPath> {
  const out = new Map<string, ComposedPath>();
  for (const id of ids) {
    const node = tree.byId.get(id) as PageTreeNode;
    const ann = annotations.get(id) ?? {};
    const isRoot = isCompositionHome(id, node.slug, node.parentPageId !== null, designated, ann);
    const resolved = resolvePageUrl(
      {
        pageId: id,
        slug: node.slug,
        ancestorSlugs: ancestorSlugsOf(tree, id),
        isHomePage: isRoot,
        annotations: ann,
      },
      view,
    );
    out.set(id, { path: resolved.path, isRoot });
  }
  return out;
}

/** {@link composePathsDetailed}, paths only. */
export async function composePaths(
  tx: TransactionRunner,
  tree: PageTree,
  pageIds: ReadonlyArray<string>,
  annotationScope: RenderScope,
  view?: UrlCompositionView,
): Promise<Map<string, string>> {
  const detailed = await composePathsDetailed(tx, tree, pageIds, annotationScope, view);
  return new Map([...detailed].map(([id, c]) => [id, c.path]));
}
