// SPDX-License-Identifier: MPL-2.0

/**
 * Where is a module still placed — as the CALLER sees the site?
 *
 * The in-use guard behind `modules.delete` for AI actors. "Placed" means
 * referenced by a live layout (site chrome) or by a page that is not
 * deleted, using the caller's chat-branch view of each page's layout:
 *
 *   - a page this chat re-laid-out (`pages.set_modules` on a branch writes
 *     a `page_layout_snapshot`, never the live `page_modules` rows) counts
 *     with its BRANCHED block list — so "remove_module_from, then delete"
 *     works inside one chat before publish;
 *   - a page with no branched layout counts with its live `page_modules`;
 *   - a page deleted on this branch (branched page snapshot with
 *     `deletedAt`) does not count.
 *
 * Layout placements are always live: layout writes are Owner-approved
 * proposals that apply to main, there is no branched layout state.
 *
 * Batched: one query per source for the whole id list, so a 200-module
 * `modules.delete_many` on a migration branch with hundreds of branched
 * pages stays a handful of round-trips.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { PageLayoutState, PageState } from "../../snapshots/state.js";

/** Pages + layouts that still place one module (slugs, sorted, deduped). */
export interface ModulePlacements {
  readonly pages: readonly string[];
  readonly layouts: readonly string[];
}

function parseState<T>(raw: unknown): T {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

function idList(ids: readonly string[]) {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/**
 * Resolve the placements of `moduleIds` as `ctx` sees the site. Modules
 * with no placement map to empty lists (every requested id is present).
 */
export async function findModulePlacements(
  tx: TransactionRunner,
  ctx: Pick<ExecutionContext, "chatBranchId">,
  moduleIds: readonly string[],
): Promise<Map<string, ModulePlacements>> {
  const pagesByModule = new Map<string, Set<string>>();
  const layoutsByModule = new Map<string, Set<string>>();
  for (const id of moduleIds) {
    pagesByModule.set(id, new Set());
    layoutsByModule.set(id, new Set());
  }
  if (moduleIds.length === 0) return new Map();

  const branchId = ctx.chatBranchId ?? null;

  // Branched page layouts + page states: latest snapshot per page on this
  // branch. Empty for callers without a branch.
  const branchedLayouts = new Map<string, PageLayoutState>();
  const branchedDeletedPages = new Set<string>();
  if (branchId) {
    const layoutRows = (await tx.execute(sql`
      SELECT DISTINCT ON (pls.page_id) pls.page_id::text AS page_id, pls.state
        FROM page_layout_snapshots pls
        JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
       WHERE ss.chat_branch_id = ${branchId}::uuid
       ORDER BY pls.page_id, ss.created_at DESC
    `)) as unknown as { page_id: string; state: unknown }[];
    for (const r of layoutRows) {
      branchedLayouts.set(r.page_id, parseState<PageLayoutState>(r.state));
    }
    const pageRows = (await tx.execute(sql`
      SELECT DISTINCT ON (ps.page_id) ps.page_id::text AS page_id, ps.state
        FROM page_snapshots ps
        JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
       WHERE ss.chat_branch_id = ${branchId}::uuid
       ORDER BY ps.page_id, ss.created_at DESC
    `)) as unknown as { page_id: string; state: unknown }[];
    for (const r of pageRows) {
      if (parseState<PageState>(r.state).deletedAt) branchedDeletedPages.add(r.page_id);
    }
  }

  // Live page placements on pages visible to the caller.
  const visible = branchId
    ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${branchId}::uuid)`
    : sql`p.chat_branch_id IS NULL`;
  const liveRows = (await tx.execute(sql`
    SELECT DISTINCT pm.module_id::text AS module_id, p.id::text AS page_id, p.slug
      FROM page_modules pm
      JOIN pages p ON p.id = pm.page_id
     WHERE pm.module_id IN (${idList(moduleIds)})
       AND p.deleted_at IS NULL AND ${visible}
  `)) as unknown as { module_id: string; page_id: string; slug: string }[];
  for (const r of liveRows) {
    // A branched layout for this page supersedes its live rows.
    if (branchedLayouts.has(r.page_id) || branchedDeletedPages.has(r.page_id)) continue;
    pagesByModule.get(r.module_id)?.add(r.slug);
  }

  // Branched layouts that (still) place a requested module.
  const wanted = new Set(moduleIds);
  const branchedHits: { moduleId: string; pageId: string }[] = [];
  for (const [pageId, layout] of branchedLayouts) {
    if (branchedDeletedPages.has(pageId)) continue;
    for (const block of layout.blocks) {
      for (const moduleId of block.moduleIds) {
        if (wanted.has(moduleId)) branchedHits.push({ moduleId, pageId });
      }
    }
  }
  if (branchedHits.length > 0) {
    const pageIds = [...new Set(branchedHits.map((h) => h.pageId))];
    const slugRows = (await tx.execute(sql`
      SELECT id::text AS id, slug FROM pages
       WHERE id IN (${idList(pageIds)}) AND deleted_at IS NULL
    `)) as unknown as { id: string; slug: string }[];
    const slugById = new Map(slugRows.map((r) => [r.id, r.slug]));
    for (const h of branchedHits) {
      const slug = slugById.get(h.pageId);
      if (slug !== undefined) pagesByModule.get(h.moduleId)?.add(slug);
    }
  }

  const layoutRows = (await tx.execute(sql`
    SELECT DISTINCT lm.module_id::text AS module_id, l.slug
      FROM layout_modules lm
      JOIN layouts l ON l.id = lm.layout_id
     WHERE lm.module_id IN (${idList(moduleIds)}) AND l.deleted_at IS NULL
  `)) as unknown as { module_id: string; slug: string }[];
  for (const r of layoutRows) layoutsByModule.get(r.module_id)?.add(r.slug);

  const out = new Map<string, ModulePlacements>();
  for (const id of moduleIds) {
    out.set(id, {
      pages: [...(pagesByModule.get(id) ?? [])].sort(),
      layouts: [...(layoutsByModule.get(id) ?? [])].sort(),
    });
  }
  return out;
}

/** True when the module is placed anywhere the caller can see. */
export function isPlaced(p: ModulePlacements | undefined): boolean {
  return p !== undefined && (p.pages.length > 0 || p.layouts.length > 0);
}

/** "3 page(s) (about, home, pricing) and layout(s) site-default" — for error copy. */
export function describePlacements(p: ModulePlacements): string {
  const parts: string[] = [];
  if (p.pages.length > 0) {
    const sample = p.pages.slice(0, 5).join(", ");
    parts.push(`${p.pages.length} page(s) (${sample}${p.pages.length > 5 ? ", …" : ""})`);
  }
  if (p.layouts.length > 0) parts.push(`layout(s) ${p.layouts.join(", ")}`);
  return parts.join(" and ");
}
