// SPDX-License-Identifier: MPL-2.0

/**
 * Nested page URLs (migration 0263) — the page tree as the URL resolver
 * and the move ops see it.
 *
 * A page's public path is its ancestor chain's slugs plus its own slug,
 * composed by the ONE resolver (`resolvePageUrl` in plugin-host). This
 * module only answers the tree questions that composition needs —
 * "what are this page's ancestor slugs?", "which pages sit below these?"
 * — over a single in-memory snapshot of the tree, so a recompute of a
 * whole subtree costs one query instead of one recursive walk per page.
 *
 * Branch view: a chat's pending page edits (slug / parent / delete) live
 * in `page_snapshots` until publish, not in the live row. Under a chat
 * scope the loader overlays the latest pending state per page, so the
 * chat sees its own moves (preview paths, conflict checks) while main
 * keeps serving the live tree.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../../draft.js";

/**
 * Deepest allowed nesting: a top-level page is level 1, so a page may
 * have at most {@link MAX_PAGE_DEPTH} - 1 ancestors. Six levels covers
 * every real information architecture we have seen while keeping URLs
 * readable and subtree moves bounded.
 */
export const MAX_PAGE_DEPTH = 6;

/** One page as the tree sees it. */
export interface PageTreeNode {
  readonly id: string;
  readonly slug: string;
  readonly parentPageId: string | null;
  /** Live-row namespace: null = main, else the creating chat's branch. */
  readonly chatBranchId: string | null;
}

/** The visible, non-deleted pages of one scope, indexed both ways. */
export interface PageTree {
  readonly byId: ReadonlyMap<string, PageTreeNode>;
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
}

interface RawNodeRow {
  id: string;
  slug: string;
  parent_page_id: string | null;
  chat_branch_id: string | null;
}

/**
 * Load the page tree visible to `chatBranchId` (null = main): live main
 * rows, plus the branch's own rows and its pending page edits overlaid
 * when a branch is given. Deleted pages (live or branch-pending) are
 * excluded.
 */
export async function loadPageTree(
  tx: TransactionRunner,
  chatBranchId: string | null,
): Promise<PageTree> {
  const visibility = chatBranchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${chatBranchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, slug, parent_page_id::text AS parent_page_id,
           chat_branch_id::text AS chat_branch_id
    FROM pages
    WHERE deleted_at IS NULL AND ${visibility}
  `)) as unknown as RawNodeRow[];
  const nodes = new Map<string, PageTreeNode>(
    rows.map((r) => [
      r.id,
      { id: r.id, slug: r.slug, parentPageId: r.parent_page_id, chatBranchId: r.chat_branch_id },
    ]),
  );
  if (chatBranchId) {
    const overlay = (await tx.execute(sql`
      SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
        FROM page_snapshots ps
        JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
       WHERE ss.chat_branch_id = ${chatBranchId}::uuid AND ${pendingSnapshotSql()}
       ORDER BY ps.page_id, ss.created_at DESC
    `)) as unknown as { page_id: string; state: unknown }[];
    for (const o of overlay) {
      const base = nodes.get(o.page_id);
      if (!base) continue;
      const s = (typeof o.state === "string" ? JSON.parse(o.state) : o.state) as {
        slug?: string;
        parentPageId?: string | null;
        deletedAt?: string | null;
      };
      if (s.deletedAt) {
        nodes.delete(o.page_id);
        continue;
      }
      nodes.set(o.page_id, {
        ...base,
        slug: s.slug ?? base.slug,
        // A pre-0263 snapshot carries no parent — the live one stands.
        parentPageId: s.parentPageId === undefined ? base.parentPageId : s.parentPageId,
      });
    }
  }
  return indexTree(nodes);
}

/** Build the children index for a node map (also used for what-if trees). */
export function indexTree(nodes: ReadonlyMap<string, PageTreeNode>): PageTree {
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes.values()) {
    if (n.parentPageId === null) continue;
    const list = childrenOf.get(n.parentPageId);
    if (list) list.push(n.id);
    else childrenOf.set(n.parentPageId, [n.id]);
  }
  return { byId: nodes, childrenOf };
}

/**
 * The ancestor chain of a page, root first (ids). Throws on a cycle or a
 * dangling parent — the move ops refuse both, so either means corrupt
 * data, which must surface rather than compose a wrong URL.
 */
export function ancestorIdsOf(tree: PageTree, pageId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([pageId]);
  let cur = tree.byId.get(pageId)?.parentPageId ?? null;
  while (cur !== null) {
    if (seen.has(cur)) {
      throw new Error(`page tree: cycle through page ${cur} (reached from ${pageId})`);
    }
    seen.add(cur);
    const node = tree.byId.get(cur);
    if (!node) {
      throw new Error(
        `page tree: page ${pageId} has parent ${cur}, which is deleted or not visible in this scope — move the page (move_pages) to a live parent or to the top level`,
      );
    }
    chain.unshift(cur);
    cur = node.parentPageId;
  }
  return chain;
}

/** Ancestor slugs, root first — the `ancestorSlugs` the resolver composes. */
export function ancestorSlugsOf(tree: PageTree, pageId: string): string[] {
  return ancestorIdsOf(tree, pageId).map((id) => (tree.byId.get(id) as PageTreeNode).slug);
}

/**
 * Every page below the given roots (excluding the roots themselves),
 * parents before children.
 */
export function descendantIdsOf(tree: PageTree, rootIds: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>(rootIds);
  const queue = [...rootIds];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const child of tree.childrenOf.get(id) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Height of the subtree rooted at `pageId` (1 = no children). */
export function subtreeHeight(tree: PageTree, pageId: string): number {
  const children = tree.childrenOf.get(pageId) ?? [];
  let max = 0;
  for (const c of children) max = Math.max(max, subtreeHeight(tree, c));
  return max + 1;
}
