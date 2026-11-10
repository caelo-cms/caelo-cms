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

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { headOverlaySql } from "../../draft.js";

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

/** A live page row as the tree reads it. */
export interface RawNodeRow {
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
  opts: {
    /** false = the stored rows only, without the branch's pending edits
     *  (what `current_path` was last composed from). */
    readonly overlay?: boolean;
  } = {},
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
  const pending = new Map<string, PendingTreeState>();
  if (chatBranchId && opts.overlay !== false) {
    // #1268 — the branch's pending pages from the draft head: one row per
    // pending page, not the pending history.
    const overlay = (await tx.execute(
      headOverlaySql({ kind: "page", table: "page_snapshots", branchId: chatBranchId }),
    )) as unknown as { entity_id: string; state: unknown }[];
    for (const o of overlay) {
      pending.set(o.entity_id, o.state as PendingTreeState);
    }
  }
  return pageTreeOf(rows, pending);
}

/** The fields of a pending page state the tree reads. */
export interface PendingTreeState {
  readonly slug?: string;
  readonly parentPageId?: string | null;
  readonly deletedAt?: string | null;
}

/**
 * The page tree of `rows` (live, non-deleted rows of one scope) with the
 * branch's pending states applied — the pure half of {@link loadPageTree},
 * shared with the preview's cached site view (#1212). Pass an empty map
 * for the stored tree (what `current_path` was last composed from).
 */
export function pageTreeOf(
  rows: readonly RawNodeRow[],
  pending: ReadonlyMap<string, PendingTreeState>,
): PageTree {
  const nodes = new Map<string, PageTreeNode>(
    rows.map((r) => [
      r.id,
      { id: r.id, slug: r.slug, parentPageId: r.parent_page_id, chatBranchId: r.chat_branch_id },
    ]),
  );
  for (const [pageId, s] of pending) {
    const base = nodes.get(pageId);
    if (!base) continue;
    if (s.deletedAt) {
      nodes.delete(pageId);
      continue;
    }
    nodes.set(pageId, {
      ...base,
      slug: s.slug ?? base.slug,
      // A pre-0263 snapshot carries no parent — the live one stands.
      parentPageId: s.parentPageId === undefined ? base.parentPageId : s.parentPageId,
    });
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

/**
 * Under a chat scope: the pages whose path the chat's pending renames /
 * moves change — the pages whose slug or parent differ between the chat's
 * `tree` and the `stored` one, plus everything below them. Their stored
 * `current_path` predates the pending change, so readers compose them.
 */
export function driftIdsBetween(tree: PageTree, stored: PageTree): string[] {
  const changed = [...tree.byId.values()]
    .filter((n) => {
      const s = stored.byId.get(n.id);
      return s !== undefined && (s.slug !== n.slug || s.parentPageId !== n.parentPageId);
    })
    .map((n) => n.id);
  return changed.length === 0 ? [] : [...changed, ...descendantIdsOf(tree, changed)];
}

/** A page of {@link loadPageChains} with its stored and its branch values. */
interface ChainRow {
  readonly id: string;
  readonly slug: string;
  readonly parentPageId: string | null;
  readonly chatBranchId: string | null;
}

/**
 * Issue #1269 — the part of the page tree `pageIds` need, as `chatBranchId`
 * sees it (null = main): those pages and their ancestors, with the
 * branch's pending slugs and parents applied, read one tree level at a
 * time (at most {@link MAX_PAGE_DEPTH} levels) — never the whole tree.
 *
 * @returns `tree` (a partial {@link PageTree}: depth, ancestor slugs and
 *   path composition work on it for `pageIds`) and `drifted`: the ids of
 *   `pageIds` whose own or an ancestor's slug or parent the branch changed,
 *   so their stored `current_path` predates the change. A page the branch
 *   deleted is left out.
 */
export async function loadPageChains(
  tx: TransactionRunner,
  chatBranchId: string | null,
  pageIds: readonly string[],
): Promise<{ tree: PageTree; drifted: Set<string> }> {
  const visibility = chatBranchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${chatBranchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  const nodes = new Map<string, PageTreeNode>();
  const changed = new Set<string>();
  let frontier = [...new Set(pageIds)];
  for (let level = 0; level <= MAX_PAGE_DEPTH && frontier.length > 0; level += 1) {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, parent_page_id::text AS parent_page_id,
             chat_branch_id::text AS chat_branch_id
        FROM pages
       WHERE id = ANY(${uuidArray(frontier)}) AND deleted_at IS NULL AND ${visibility}
    `)) as unknown as RawNodeRow[];
    const stored = new Map<string, ChainRow>(
      rows.map((r) => [
        r.id,
        { id: r.id, slug: r.slug, parentPageId: r.parent_page_id, chatBranchId: r.chat_branch_id },
      ]),
    );
    const pending = new Map<string, PendingTreeState>();
    if (chatBranchId && rows.length > 0) {
      const heads = (await tx.execute(
        headOverlaySql({
          kind: "page",
          table: "page_snapshots",
          branchId: chatBranchId,
          ids: rows.map((r) => r.id),
        }),
      )) as unknown as { entity_id: string; state: PendingTreeState }[];
      for (const h of heads) pending.set(h.entity_id, h.state);
    }
    const next = new Set<string>();
    for (const s of stored.values()) {
      const p = pending.get(s.id);
      if (p?.deletedAt) continue;
      const slug = p?.slug ?? s.slug;
      const parentPageId = p?.parentPageId === undefined ? s.parentPageId : p.parentPageId;
      if (slug !== s.slug || parentPageId !== s.parentPageId) changed.add(s.id);
      nodes.set(s.id, { id: s.id, slug, parentPageId, chatBranchId: s.chatBranchId });
      if (parentPageId !== null && !nodes.has(parentPageId)) next.add(parentPageId);
    }
    frontier = [...next];
  }
  const tree = indexTree(nodes);
  const drifted = new Set<string>();
  for (const id of pageIds) {
    if (!nodes.has(id)) continue;
    let cur: string | null = id;
    for (let depth = 0; cur !== null && depth <= MAX_PAGE_DEPTH; depth += 1) {
      if (changed.has(cur)) {
        drifted.add(id);
        break;
      }
      cur = nodes.get(cur)?.parentPageId ?? null;
    }
  }
  return { tree, drifted };
}

/**
 * Issue #1269 — the ids of every page below `rootIds` as `chatBranchId`
 * sees the tree (the roots themselves are never listed),
 * read one level at a time for all roots together (at most
 * {@link MAX_PAGE_DEPTH} levels, so the round trips are bounded by the
 * depth, not the number of roots)
 * from the parent index and, on a branch, the pending pages whose head
 * names a parent of the level (moved in). The cost is the subtree, never
 * the site.
 */
export async function loadSubtreeIds(
  tx: TransactionRunner,
  chatBranchId: string | null,
  rootIds: string | readonly string[],
): Promise<string[]> {
  const visibility = chatBranchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${chatBranchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  const roots = [...new Set(typeof rootIds === "string" ? [rootIds] : rootIds)];
  const below: string[] = [];
  const seen = new Set<string>(roots);
  let frontier = roots;
  for (let level = 0; level < MAX_PAGE_DEPTH && frontier.length > 0; level += 1) {
    const live = (await tx.execute(sql`
      SELECT id::text AS id, parent_page_id::text AS parent_page_id FROM pages
       WHERE parent_page_id = ANY(${uuidArray(frontier)}) AND deleted_at IS NULL AND ${visibility}
    `)) as unknown as { id: string; parent_page_id: string }[];
    let candidates = live.map((r) => r.id);
    if (chatBranchId) {
      const movedIn = (await tx.execute(sql`
        SELECT DISTINCT d.entity_id::text AS id FROM draft_pending_entities d
         WHERE d.chat_branch_id = ${chatBranchId}::uuid AND d.entity_kind = 'page'
           AND d.parent_page_id = ANY(${uuidArray(frontier)})
      `)) as unknown as { id: string }[];
      candidates = [...new Set([...candidates, ...movedIn.map((r) => r.id)])];
      // Each candidate's newest parent and deletion decide (moved out, deleted).
      const liveParent = new Map(live.map((r) => [r.id, r.parent_page_id]));
      const heads = candidates.length
        ? ((await tx.execute(
            headOverlaySql({
              kind: "page",
              table: "page_snapshots",
              branchId: chatBranchId,
              ids: candidates,
            }),
          )) as unknown as { entity_id: string; state: PendingTreeState }[])
        : [];
      const head = new Map(heads.map((h) => [h.entity_id, h.state]));
      const level = new Set(frontier);
      candidates = candidates.filter((id) => {
        const h = head.get(id);
        if (h?.deletedAt) return false;
        const parent = h?.parentPageId === undefined ? liveParent.get(id) : h.parentPageId;
        return parent !== undefined && parent !== null && level.has(parent);
      });
    }
    const next = candidates.filter((id) => !seen.has(id));
    for (const id of next) {
      seen.add(id);
      below.push(id);
    }
    frontier = next;
  }
  return below;
}

/**
 * Issue #1269 — the part of the page tree a path recompute of `rootIds`
 * needs: those pages, every page below them, and their ancestors, as
 * `chatBranchId` sees them — read through the subtree and ancestor
 * walks, never the whole tree. `below` lists the descendants (each once).
 */
export async function loadScopedTree(
  tx: TransactionRunner,
  chatBranchId: string | null,
  rootIds: readonly string[],
): Promise<{ tree: PageTree; below: string[] }> {
  const roots = [...new Set(rootIds)];
  // One walk for all roots: round trips bounded by the tree depth.
  const below = await loadSubtreeIds(tx, chatBranchId, roots);
  const { tree } = await loadPageChains(tx, chatBranchId, [...roots, ...below]);
  return { tree, below };
}
