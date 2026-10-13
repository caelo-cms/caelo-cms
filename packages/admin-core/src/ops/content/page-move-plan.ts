// SPDX-License-Identifier: MPL-2.0

/**
 * Nested page URLs — validate a set of tree changes BEFORE anything is
 * written, in the caller's branch view.
 *
 * Every op that changes where pages sit (create under a parent, rename,
 * reparent, subtree move) runs its request through {@link planPageMoves}:
 * it applies the changes to an in-memory copy of the tree, checks the
 * structural rules (no cycles, at most {@link MAX_PAGE_DEPTH} levels, the
 * homepage neither has nor is a parent), composes every page's path in
 * the what-if tree and refuses any path that two pages would share. Only
 * a clean plan reaches the write; a refused plan changes nothing.
 *
 * Every refusal names the next step, because the AI is the primary
 * caller (CLAUDE.md §11: failure surfaces are AI-actionable).
 */

import type { RenderScope } from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { composePathsDetailed, type PathMove } from "./current-path.js";
import {
  ancestorIdsOf,
  descendantIdsOf,
  indexTree,
  loadPageTree,
  MAX_PAGE_DEPTH,
  type PageTree,
  type PageTreeNode,
  pendingDriftIds,
} from "./page-tree.js";

/** One requested change. `parentPageId: undefined` keeps the parent. */
export interface TreeChange {
  readonly pageId: string;
  readonly parentPageId?: string | null;
  readonly newSlug?: string;
  /** A page that does not exist yet (pages.create): planned, never loaded. */
  readonly isNew?: boolean;
}

/** A clean plan: the URLs that will move, and every affected page. */
export interface PageMovePlan {
  /** Changed pages + all their descendants, parents first. */
  readonly affectedIds: readonly string[];
  /** Old → new path for every affected existing page whose URL changes. */
  readonly moves: readonly PathMove[];
  /** New path per affected page (new pages included). */
  readonly pathsAfter: ReadonlyMap<string, string>;
}

export type PageMovePlanResult =
  | { readonly ok: true; readonly plan: PageMovePlan }
  | { readonly ok: false; readonly message: string };

function refuse(message: string): PageMovePlanResult {
  return { ok: false, message };
}

/** Stored `current_path` of every page visible in the scope. */
async function loadVisiblePaths(
  tx: TransactionRunner,
  chatBranchId: string | null,
): Promise<Map<string, string>> {
  const visibility = chatBranchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${chatBranchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, current_path FROM pages WHERE deleted_at IS NULL AND ${visibility}
  `)) as unknown as { id: string; current_path: string }[];
  return new Map(rows.map((r) => [r.id, r.current_path]));
}

function depthIn(tree: PageTree, pageId: string): number {
  return ancestorIdsOf(tree, pageId).length + 1;
}

/**
 * Validate `changes` against the tree visible in `scope` and compute the
 * URL moves they cause. Pure planning — no writes.
 */
export async function planPageMoves(
  tx: TransactionRunner,
  scope: RenderScope,
  changes: readonly TreeChange[],
): Promise<PageMovePlanResult> {
  const tree = await loadPageTree(tx, scope.chatBranchId);
  const seen = new Set<string>();
  for (const c of changes) {
    if (seen.has(c.pageId)) {
      return refuse(`page ${c.pageId} appears twice in one call — pass each page once`);
    }
    seen.add(c.pageId);
    if (!c.isNew && !tree.byId.has(c.pageId)) {
      return refuse(
        `page ${c.pageId} not found (or deleted in this chat) — call list_pages for live page ids`,
      );
    }
    if (c.parentPageId && !tree.byId.has(c.parentPageId)) {
      return refuse(
        `parent page ${c.parentPageId} not found (or deleted in this chat) — call list_pages and pass a live page id as the parent, or null for the top level`,
      );
    }
  }

  // Apply the changes to a copy of the tree.
  const whatIf = new Map<string, PageTreeNode>(tree.byId);
  for (const c of changes) {
    const base = whatIf.get(c.pageId);
    whatIf.set(c.pageId, {
      id: c.pageId,
      slug: c.newSlug ?? base?.slug ?? "",
      parentPageId: c.parentPageId === undefined ? (base?.parentPageId ?? null) : c.parentPageId,
      chatBranchId: base?.chatBranchId ?? scope.chatBranchId,
    });
  }
  const whatIfTree = indexTree(whatIf);

  // Only the pages a change can move are composed — plugin annotation
  // calls stay bounded, and an unrelated page's plugin data cannot block
  // this write. Every other page holds its stored path, except (in a
  // chat) pages whose own pending rename / move makes it stale.
  const changedRoots = changes.map((c) => c.pageId);
  const affectedIds = [...changedRoots, ...descendantIdsOf(whatIfTree, changedRoots)];
  const drifted = scope.chatBranchId ? await pendingDriftIds(tx, tree, scope.chatBranchId) : [];
  const parentIds = changes
    .map((c) => (whatIf.get(c.pageId) as PageTreeNode).parentPageId)
    .filter((id): id is string => id !== null);
  const before = await composePathsDetailed(
    tx,
    tree,
    [...affectedIds, ...parentIds, ...drifted],
    scope,
  );

  for (const c of changes) {
    const node = whatIf.get(c.pageId) as PageTreeNode;
    if (node.parentPageId === null) continue;
    if (!c.isNew && before.get(c.pageId)?.isRoot) {
      return refuse(
        `page ${before.get(c.pageId)?.path ?? c.pageId} is a homepage (it serves at the root of its URL space) and cannot be placed under another page. Top-level pages already sit directly under it — leave parentPageId null.`,
      );
    }
    const parentComposed = before.get(node.parentPageId);
    if (parentComposed?.isRoot) {
      return refuse(
        `the homepage (${parentComposed.path}) cannot be a parent — top-level pages already sit directly under it. Pass parentPageId null to place the page at the top level.`,
      );
    }
    try {
      ancestorIdsOf(whatIfTree, c.pageId);
    } catch {
      return refuse(
        `moving page ${before.get(c.pageId)?.path ?? c.pageId} under ${parentComposed?.path ?? node.parentPageId} would create a loop — a page cannot sit below itself or one of its own descendants. Pick a parent outside its subtree.`,
      );
    }
  }

  for (const id of affectedIds) {
    const depth = depthIn(whatIfTree, id);
    if (depth > MAX_PAGE_DEPTH) {
      const where = before.get(id)?.path ?? id;
      return refuse(
        `this would nest ${where} ${depth} levels deep; pages can be nested at most ${MAX_PAGE_DEPTH} levels (a top-level page is level 1). Choose a parent higher up the tree.`,
      );
    }
  }

  // Refuse any path an affected page would share with another page.
  const after = await composePathsDetailed(tx, whatIfTree, [...affectedIds, ...drifted], scope);
  const affected = new Set(affectedIds);
  const stored = await loadVisiblePaths(tx, scope.chatBranchId);
  const holderOf = new Map<string, string>();
  for (const id of tree.byId.keys()) {
    if (affected.has(id)) continue;
    const path = after.get(id)?.path ?? stored.get(id);
    if (path !== undefined) holderOf.set(path, id);
  }
  const claimedBy = new Map<string, string>();
  for (const id of affectedIds) {
    const target = after.get(id)?.path;
    if (target === undefined) continue;
    const clash = holderOf.get(target) ?? claimedBy.get(target);
    if (clash !== undefined) {
      const mover = before.get(id)?.path ?? "the new page";
      const changed = changes.find((c) => c.pageId === id);
      const hint = changed
        ? "Pass a different `newSlug` for it in the same call (the move and the rename apply together, with redirects from the old URLs)."
        : "It moves because an ancestor moves; rename the moving ancestor (`newSlug`) or the clashing page first.";
      return refuse(
        `URL conflict: ${mover} would move to ${target}, which is already page ${clash}'s URL. ${hint}`,
      );
    }
    claimedBy.set(target, id);
  }

  const moves: PathMove[] = [];
  const pathsAfter = new Map<string, string>();
  for (const id of affectedIds) {
    const to = after.get(id)?.path;
    if (to === undefined) continue;
    pathsAfter.set(id, to);
    const from = before.get(id)?.path;
    if (from !== undefined && from !== to) moves.push({ pageId: id, from, to });
  }
  return { ok: true, plan: { affectedIds, moves, pathsAfter } };
}
