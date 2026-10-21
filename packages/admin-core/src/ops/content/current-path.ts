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
  hostSystemActorId,
  type RenderScope,
  type UrlCompositionView,
} from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { composePaths, renderScopeOf } from "./compose-paths.js";
import {
  ancestorIdsOf,
  descendantIdsOf,
  loadPageTree,
  type PageTree,
  type PageTreeNode,
} from "./page-tree.js";
import { applyPathMoveEffects } from "./path-moves.js";

export {
  composePaths,
  composePathsDetailed,
  renderScopeOf,
} from "./compose-paths.js";

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
 * the input the 301 side effects need.
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
 * #586 — main-line pages whose stored path differs from a fresh
 * composition under committed main state, i.e. the moves an approved
 * URL migration (`url_migrations.propose_migrate`) would apply. A
 * URL-setting change (a locale strategy, `prefixDefaultLocale`) leaves
 * pages here until the Owner approves the migration that writes their
 * 301s; side-path recomputes must not move them first.
 */
async function pendingMigrationPageIds(
  tx: TransactionRunner,
  tree: PageTree,
): Promise<Set<string>> {
  const ids = [...tree.byId.keys()];
  const fresh = await composePaths(tx, tree, ids, { chatBranchId: null });
  const stored = await loadStoredPaths(tx, ids);
  return new Set(ids.filter((id) => stored.get(id) !== fresh.get(id)));
}

/** True when a fresh main composition moves a published page of `pageIds`. */
async function movesPublishedPage(
  tx: TransactionRunner,
  tree: PageTree,
  pageIds: ReadonlyArray<string>,
): Promise<boolean> {
  const published = (await tx.execute(sql`
    SELECT id::text AS id FROM pages
    WHERE status = 'published' AND id IN (${sql.join(
      pageIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string }[];
  if (published.length === 0) return false;
  const ids = published.map((r) => r.id);
  const fresh = await composePaths(tx, tree, ids, { chatBranchId: null });
  const stored = await loadStoredPaths(tx, ids);
  return ids.some((id) => stored.get(id) !== fresh.get(id));
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
  view?: UrlCompositionView,
): Promise<Map<string, string>> {
  if (pageIds.length === 0) return new Map();
  const tree = await loadPageTree(tx, scope.chatBranchId);
  return composePaths(tx, tree, pageIds, scope, view);
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
    /** #586 — true when the page did not move because the move belongs
     *  to a URL migration still waiting for the Owner's approval. */
    awaitingUrlMigration: z.boolean(),
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
      return ok({ path, moved: false, awaitingUrlMigration: false });
    }
    // #586 — while a URL-setting change waits for its migration, pages
    // outside this subtree drift too: the move is the setting's, not this
    // page's data, and only the approved migration may apply it (with
    // its 301s). The migration diff includes this page, so nothing is
    // lost by waiting. A page whose drift is confined to its own subtree
    // is the page-local case this op exists for (a variant link). Only a
    // published page has a public URL to protect; a draft (a fresh
    // variant) moves freely, without composing the whole site.
    const tree = await loadPageTree(tx, null);
    const subtree = [input.pageId, ...descendantIdsOf(tree, [input.pageId])];
    const movesPublished = await movesPublishedPage(tx, tree, subtree);
    const pending = movesPublished ? await pendingMigrationPageIds(tx, tree) : new Set<string>();
    if ([...pending].some((id) => !subtree.includes(id))) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "pages.refresh_current_path",
        input,
        succeeded: true,
        entityId: input.pageId,
        resultSummary: `unchanged: URL migration pending (${pending.size} pages)`,
      });
      return ok({ path: oldPath, moved: false, awaitingUrlMigration: true });
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
    return ok({ path: newPath, moved, awaitingUrlMigration: false });
  },
});

/**
 * Recompose main-line paths after a merge, and give every page that moved
 * the full move treatment (301, chain collapse, redirect reclaim —
 * {@link applyPathMoveEffects}). Two merge inputs can move URLs:
 *
 * - replayed page rows (a chat renamed or reparented pages): those pages
 *   and their subtrees are recomposed from the in-tx, post-replay tree —
 *   the same composition a direct `pages.update` runs;
 * - plugin rows (a locale variant link): every page whose composition
 *   those rows change is recomposed — not pages that only drift from a
 *   pending URL-setting change (#586, see below). Plugin calls run in
 *   their own transactions and cannot see the
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
    /** Replayed pages whose pending rename / move asked for no 301s;
     *  their subtrees' moves honour it too. */
    readonly skipRedirectPageIds: ReadonlySet<string>;
  },
): Promise<string[]> {
  const tree = await loadPageTree(tx, null);
  const roots = opts.replayedPageIds.filter((id) => tree.byId.has(id));
  const replayed = [...roots, ...descendantIdsOf(tree, roots)];
  let composed: Map<string, string>;
  if (opts.pluginRowsMerged) {
    // Without the plugin host loaded no URL plugin would answer, and every
    // prefixed path (/de/…) would recompose bare. Fail rather than strip.
    hostSystemActorId();
    // #586 — only pages the merge itself moves: the replayed subtrees,
    // the newly live pages, and pages whose composition the merged plugin
    // rows change (branch view ≠ committed main). A page that composes
    // the same either way but differs from its stored path is drifting
    // from a URL-setting change; its move waits for the approved URL
    // migration, which also writes the 301s.
    const all = [...tree.byId.keys()];
    const withMerge = await composePaths(tx, tree, all, { chatBranchId });
    const withoutMerge = await composePaths(tx, tree, all, { chatBranchId: null });
    const caused = new Set([
      ...replayed,
      ...opts.newlyLivePageIds,
      ...all.filter((id) => withMerge.get(id) !== withoutMerge.get(id)),
    ]);
    composed = new Map([...withMerge].filter(([id]) => caused.has(id)));
  } else {
    composed = await composePaths(tx, tree, replayed, { chatBranchId: null });
  }
  const targets = [...composed.keys()];
  if (targets.length === 0) return [];
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
  const effective = moves.filter((m) => !opts.newlyLivePageIds.has(m.pageId));
  const skips = (id: string): boolean =>
    opts.skipRedirectPageIds.has(id) ||
    ancestorIdsOf(tree, id).some((a) => opts.skipRedirectPageIds.has(a));
  await applyPathMoveEffects(ctx, tx, effective, { skip: skips });
  return moves.map((m) => m.pageId);
}
