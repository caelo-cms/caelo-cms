// SPDX-License-Identifier: MPL-2.0

/**
 * #390 — `pages.current_path` recompute at the write boundary.
 *
 * The composed public path is MATERIALIZED: every op that can change a
 * page's URL shape (create, slug update, duplicate, home-designation
 * flip) recomputes the affected rows inside its own transaction, so
 * render-time consumers read one column and the URL-diff engine can
 * compare stored paths against fresh resolutions even after the
 * contributing plugin is gone.
 *
 * Resolution = the plugin-host composition point: an I/O phase collects
 * each contributing plugin's per-page annotations, then the pure
 * resolver composes. With no URL plugins active this degrades to
 * "/<slug>" (home → "/") — the same shape the 0211 backfill wrote.
 */

import {
  collectUrlAnnotations,
  hostSystemActorId,
  type RenderScope,
  resolvePageUrl,
} from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation } from "@caelo-cms/query-api";
import { type ExecutionContext, err, isHomeSlug, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import {
  ancestorSlugsOf,
  descendantIdsOf,
  loadPageTree,
  type PageTree,
  type PageTreeNode,
} from "./page-tree.js";
import { applyPathMoveEffects } from "./path-moves.js";

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

async function loadDesignatedHomePageId(tx: TransactionRunner): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT home_page_id::text AS home_page_id FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { home_page_id: string | null }[];
  return rows[0]?.home_page_id ?? null;
}

/** The render scope a write runs in: its chat branch, or main. */
export function renderScopeOf(ctx: ExecutionContext): RenderScope {
  return { chatBranchId: ctx.chatBranchId ?? null };
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
 */
export async function composePathsDetailed(
  tx: TransactionRunner,
  tree: PageTree,
  pageIds: ReadonlyArray<string>,
  annotationScope: RenderScope,
): Promise<Map<string, ComposedPath>> {
  const out = new Map<string, ComposedPath>();
  const ids = [...new Set(pageIds)].filter((id) => tree.byId.has(id));
  if (ids.length === 0) return out;
  const designated = await loadDesignatedHomePageId(tx);
  const annotations = await collectUrlAnnotations(ids, annotationScope);
  for (const id of ids) {
    const node = tree.byId.get(id) as PageTreeNode;
    const ann = annotations.get(id) ?? {};
    const isRoot = isCompositionHome(id, node.slug, node.parentPageId !== null, designated, ann);
    const resolved = resolvePageUrl({
      pageId: id,
      slug: node.slug,
      ancestorSlugs: ancestorSlugsOf(tree, id),
      isHomePage: isRoot,
      annotations: ann,
    });
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
): Promise<Map<string, string>> {
  const detailed = await composePathsDetailed(tx, tree, pageIds, annotationScope);
  return new Map([...detailed].map(([id, c]) => [id, c.path]));
}

/**
 * Write new `current_path` values, vacating before claiming: inside one
 * statement sequence two pages may swap paths (a home flip, a subtree
 * moved onto a sibling's old URL), and `current_path` is unique per
 * branch namespace.
 */
async function writeCurrentPaths(
  tx: TransactionRunner,
  changes: ReadonlyArray<{ id: string; path: string }>,
): Promise<void> {
  for (const c of changes) {
    await tx.execute(sql`
      UPDATE pages SET current_path = current_path || ${`#moving-${c.id}`}
      WHERE id = ${c.id}::uuid
    `);
  }
  for (const c of changes) {
    await tx.execute(sql`UPDATE pages SET current_path = ${c.path} WHERE id = ${c.id}::uuid`);
  }
}

/**
 * Recompute `current_path` for the given pages AND every page below
 * them (a parent's path is a prefix of its children's), under `scope`,
 * and persist it where that scope owns the row. Plugin URL annotations
 * can live on a chat branch (e.g. a variant link written in a chat), so
 * a branch composes with its own plugin state and its own pending tree:
 *
 * - main scope persists every given row (existing behaviour);
 * - a branch scope persists only rows that branch created — a main
 *   row's live path must not move before publish. The merge recomputes
 *   main-line paths once the branch's rows are live
 *   ({@link refreshLivePathsAfterMerge}).
 *
 * @returns the composed path per page (given pages and their
 *   descendants), persisted or not, plus the previous stored path of
 *   every row whose stored path changed.
 */
export async function recomputeCurrentPaths(
  tx: TransactionRunner,
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
): Promise<Map<string, string>> {
  return (await recomputeCurrentPathsWithMoves(tx, pageIds, scope)).paths;
}

/** A persisted path change: where the page was, and where it is now. */
export interface PathMove {
  readonly pageId: string;
  readonly from: string;
  readonly to: string;
}

/**
 * {@link recomputeCurrentPaths}, also reporting every persisted move —
 * the input the 301 + link-rewrite side effects need.
 */
export async function recomputeCurrentPathsWithMoves(
  tx: TransactionRunner,
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
): Promise<{ paths: Map<string, string>; moves: PathMove[] }> {
  const uniqueIds = [...new Set(pageIds)];
  if (uniqueIds.length === 0) return { paths: new Map(), moves: [] };
  const tree = await loadPageTree(tx, scope.chatBranchId);
  const targets = [...uniqueIds, ...descendantIdsOf(tree, uniqueIds)];
  const paths = await composePaths(tx, tree, targets, scope);
  const stored = await loadStoredPaths(tx, [...paths.keys()]);
  const moves: PathMove[] = [];
  for (const [id, path] of paths) {
    const node = tree.byId.get(id) as PageTreeNode;
    if (scope.chatBranchId !== null && node.chatBranchId !== scope.chatBranchId) continue;
    const from = stored.get(id);
    if (from === undefined || from === path) continue;
    moves.push({ pageId: id, from, to: path });
  }
  await writeCurrentPaths(
    tx,
    moves.map((m) => ({ id: m.pageId, path: m.to })),
  );
  return { paths, moves };
}

async function loadStoredPaths(
  tx: TransactionRunner,
  pageIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  if (pageIds.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, current_path FROM pages
    WHERE id IN (${sql.join(
      pageIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string; current_path: string }[];
  return new Map(rows.map((r) => [r.id, r.current_path]));
}

/**
 * Resolve WITHOUT persisting — the diff engine's and the branch
 * preview's "what would the paths be" half. Same tree + composition as
 * the recompute; under a chat scope the chat's pending moves apply.
 */
export async function resolveCurrentPathsDryRun(
  tx: TransactionRunner,
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
): Promise<Map<string, string>> {
  if (pageIds.length === 0) return new Map();
  const tree = await loadPageTree(tx, scope.chatBranchId);
  return composePaths(tx, tree, pageIds, scope);
}

/**
 * #396 — refresh one page's composed path after PLUGIN DATA changed its
 * URL shape (a variant link/unlink changes the locale annotation and
 * with it the prefix). Bounded to ONE page, undoable by the inverse
 * data change, so it stays routine (§11.A test) — unlike a
 * contribution-SET change, which fans out site-wide and goes through
 * propose_url_migration. When the path moves, the old URL gets the
 * same 301 treatment a slug change gets.
 */
export const refreshCurrentPathOp = defineOperation({
  name: "pages.refresh_current_path",
  // Plugins call this after writing variant rows; the AI/system may
  // call it when repairing drift. Never destructive: recompute + 301.
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid(),
      redirectFromOld: z.enum(["auto", "skip"]).default("auto"),
    })
    .strict(),
  output: z.object({
    path: z.string(),
    moved: z.boolean(),
  }),
  handler: async (ctx, input, tx) => {
    const before = (await tx.execute(sql`
      SELECT current_path, slug, chat_branch_id::text AS chat_branch_id
      FROM pages WHERE id = ${input.pageId}::uuid AND deleted_at IS NULL
    `)) as unknown as { current_path: string; slug: string; chat_branch_id: string | null }[];
    const oldPath = before[0]?.current_path;
    if (oldPath === undefined) {
      return err({
        kind: "HandlerError",
        operation: "pages.refresh_current_path",
        message: "page not found or deleted",
      });
    }
    const scope = renderScopeOf(ctx);
    const row = before[0];
    if (row && scope.chatBranchId !== null && row.chat_branch_id !== scope.chatBranchId) {
      // A main page refreshed from a chat: its live URL must not move
      // before publish. Report the branch's view; the merge applies it.
      const preview = await resolveCurrentPathsDryRun(tx, [input.pageId], scope);
      const path = preview.get(input.pageId) ?? oldPath;
      return ok({ path, moved: false });
    }
    const recomputed = await recomputeCurrentPathsWithMoves(tx, [input.pageId], scope);
    const newPath = recomputed.paths.get(input.pageId);
    if (!newPath) {
      return err({
        kind: "HandlerError",
        operation: "pages.refresh_current_path",
        message: "recompute returned no path — page vanished mid-transaction",
      });
    }
    const moved = newPath !== oldPath;
    // The page and, when nested children derive their path from it, its
    // descendants: each gets the full move treatment.
    await applyPathMoveEffects(ctx, tx, recomputed.moves, input.redirectFromOld);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "pages.refresh_current_path",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: moved ? `${oldPath} → ${newPath}` : "unchanged",
    });
    return ok({ path: newPath, moved });
  },
});

/**
 * Recompose main-line paths after a merge, and give every page that moved
 * the full move treatment (301, chain collapse, link rewrites —
 * {@link applyPathMoveEffects}). Two merge inputs can move URLs:
 *
 * - replayed page rows (a chat renamed or reparented pages): those pages
 *   and their subtrees are recomposed from the in-tx, post-replay tree —
 *   the same composition a direct `pages.update` runs;
 * - plugin rows (a locale variant link): every live page is recomposed.
 *   Plugin calls run in their own transactions and cannot see the
 *   merge's uncommitted writes, so the annotations are read in the
 *   BRANCH view — committed main plus the branch overlay — which is
 *   exactly the post-merge state when the merge takes every plugin row
 *   the branch holds (the caller guarantees that).
 *
 * Pages that only now became live (created on the branch) get their
 * path but no move effects: their old path was never public.
 *
 * @returns the pages whose live path moved.
 */
export async function refreshLivePathsAfterMerge(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  chatBranchId: string,
  opts: {
    readonly pluginRowsMerged: boolean;
    readonly replayedPageIds: readonly string[];
    readonly newlyLivePageIds: ReadonlySet<string>;
  },
): Promise<string[]> {
  const tree = await loadPageTree(tx, null);
  let targets: string[];
  let annotationScope: RenderScope;
  if (opts.pluginRowsMerged) {
    // Without the plugin host loaded no URL plugin would answer, and every
    // prefixed path (/de/…) would recompose bare. Fail rather than strip.
    hostSystemActorId();
    targets = [...tree.byId.keys()];
    annotationScope = { chatBranchId };
  } else {
    const roots = opts.replayedPageIds.filter((id) => tree.byId.has(id));
    targets = [...roots, ...descendantIdsOf(tree, roots)];
    annotationScope = { chatBranchId: null };
  }
  if (targets.length === 0) return [];
  const composed = await composePaths(tx, tree, targets, annotationScope);
  const stored = await loadStoredPaths(tx, targets);
  const moves: PathMove[] = [];
  for (const [id, to] of composed) {
    const from = stored.get(id);
    if (from !== undefined && from !== to) moves.push({ pageId: id, from, to });
  }
  await writeCurrentPaths(
    tx,
    moves.map((m) => ({ id: m.pageId, path: m.to })),
  );
  await applyPathMoveEffects(
    ctx,
    tx,
    moves.filter((m) => !opts.newlyLivePageIds.has(m.pageId)),
    "auto",
  );
  return moves.map((m) => m.pageId);
}
