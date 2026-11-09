// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1269 — the pages that can hold a given path in a branch's view,
 * found from the path's last segment (indexed) instead of composing the
 * whole tree: shared by pages.list's path filter and the move planner's
 * URL-conflict check.
 */

import { type TransactionRunner, textArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { annotationDriftPaths, pendingUrlAnnotationPageIds } from "./branch-url-drift.js";
import { loadPageChains } from "./page-tree.js";

/** A path without query, fragment or trailing slash ("/" stays "/"). */
export function normalisedPath(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? path;
  return bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
}

/**
 * On a branch, the pages that could carry one of `paths` once the
 * branch's pending renames and moves are applied, though their stored
 * `current_path` differs: a page's composed path ends in its own slug, so
 * the candidates are the visible pages and the branch's pending pages
 * whose slug is a path's last segment (indexed, 0596; the magic home
 * slugs for "/"). A URL-space root keeps its path when renamed, so the
 * stored path finds it. The caller keeps those whose composed path
 * matches. The cost is the pages sharing those slugs, never a subtree.
 *
 * A pending row of a URL plugin can give a page a path that does not end
 * in its slug (a locale root serves at its prefix, #1411). Those pages are
 * composed here and only an exact match is returned: the caller's LIMIT
 * runs before its path filter, so unrelated pages must not take its rows.
 * That composition costs the branch's pending rows of URL plugins.
 */
export async function pagesNamedByLastSegment(
  tx: TransactionRunner,
  branchId: string,
  paths: readonly string[],
): Promise<string[]> {
  const rows = await pagesWithSlugs(tx, branchId, lastSegmentsOf(paths));
  const annotated = await pendingUrlAnnotationPageIds(tx, branchId);
  const { tree } = await loadPageChains(tx, branchId, annotated);
  const wanted = new Set(paths);
  const composedThere = [...(await annotationDriftPaths(tx, tree, annotated, branchId))]
    .filter(([, path]) => wanted.has(normalisedPath(path)))
    .map(([id]) => id);
  return [...rows, ...composedThere];
}

/**
 * The visible pages, and the branch's pending pages, whose slug is one of
 * `slugs` (indexed: pages_slug_idx, draft_pending_entities_page_slug_idx).
 */
export async function pagesWithSlugs(
  tx: TransactionRunner,
  branchId: string,
  slugs: readonly string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const rows = (await tx.execute(sql`
    SELECT id::text AS id FROM pages
     WHERE slug = ANY(${textArray([...slugs])}) AND deleted_at IS NULL
       AND (chat_branch_id IS NULL OR chat_branch_id = ${branchId}::uuid)
    UNION
    SELECT DISTINCT d.entity_id::text FROM draft_pending_entities d
     WHERE d.chat_branch_id = ${branchId}::uuid AND d.entity_kind = 'page'
       AND d.slug = ANY(${textArray([...slugs])})
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/** The last segment of each path ("/" names the home slugs). */
export function lastSegmentsOf(paths: readonly string[]): string[] {
  const slugs = new Set<string>();
  for (const p of paths) {
    const last = p
      .split("/")
      .filter((x) => x !== "")
      .at(-1);
    if (last === undefined) for (const h of ["", "home", "index"]) slugs.add(h);
    else slugs.add(last);
  }
  return [...slugs];
}

/**
 * The pages whose slug or parent a pending state on the branch changes
 * (a superset: a page several chats changed has a head row per chat; the
 * caller confirms on the newest state). Costs the branch's pending pages,
 * never the site.
 */
export async function pendingRenamedPages(
  tx: TransactionRunner,
  branchId: string,
): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT d.entity_id::text AS id
      FROM draft_pending_entities d
      JOIN pages p ON p.id = d.entity_id::uuid
     WHERE d.chat_branch_id = ${branchId}::uuid AND d.entity_kind = 'page'
       AND (d.slug IS DISTINCT FROM p.slug OR d.parent_page_id IS DISTINCT FROM p.parent_page_id)
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}
