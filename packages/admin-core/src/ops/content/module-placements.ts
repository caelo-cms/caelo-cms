// SPDX-License-Identifier: MPL-2.0

/**
 * Where is a module still placed — as the CALLER sees the site?
 *
 * The one answer behind the in-use guard of `modules.delete` for AI actors,
 * the usage column of `list_modules` (`modules.list_usage`) and the blast
 * radius of `get_module_impact` (#1424): an AI that reads "unplaced" here
 * and deletes must never lose a placement the guard would have seen.
 * "Placed" means referenced by a live layout (site chrome) or by a page
 * that is not deleted, using the caller's chat-branch view of each page's
 * layout:
 *
 *   - a page this chat re-laid-out (`pages.set_modules` on a branch writes
 *     a `page_layout_snapshot`, never the live `page_modules` rows) counts
 *     with its BRANCHED block list — so "remove_module_from, then delete"
 *     works inside one chat before publish;
 *   - a page with no branched layout counts with its live `page_modules`;
 *   - a page deleted on this branch (branched page snapshot with
 *     `deletedAt`) does not count.
 *
 * Only PENDING branch snapshots count (not staged, not undone — the
 * boundary every branch-overlay reader uses): Stage consumed the others into main,
 * so an already-staged unplacement must not hide a placement another
 * chat has since made live.
 *
 * A module nested inside another module's content (a `module` /
 * `module-list` field of a content instance, rendered recursively with no
 * `page_modules` row of its own) is placed too — `nestedIn` names the
 * parent modules.
 *
 * Layout placements are always live: layout writes are Owner-approved
 * proposals that apply to main, there is no branched layout state.
 *
 * Batched: one query per source for the whole id list, so a 200-module
 * `modules.delete_many` on a migration branch with hundreds of branched
 * pages stays a handful of round-trips.
 *
 * Bounded for hot paths: `list_modules` runs on every catalog read, and a
 * product hero sits on every product page, so `limitPerModule` stops each
 * module's walk after that many placements ({@link usageOfModules}). Only
 * the unbounded callers (the delete guard, content-instance reach) pay for
 * all of a module's placements.
 */

import { type TransactionRunner, uuidArray } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { loadBranchedModuleStates } from "../../snapshots/load.js";
import { findContentInstancesContaining, idNeedles } from "./content-instance-refs.js";
import { effectiveLayoutModulesSql } from "./layout-overlay.js";

/** Pages + layouts that still place one module (sorted, deduped). */
export interface ModulePlacements {
  /** Page URL paths — unique per page, unlike slugs (epic #690). */
  readonly pages: readonly string[];
  readonly layouts: readonly string[];
  /** Slugs of modules whose content instances nest this module. */
  readonly nestedIn: readonly string[];
}

/** One page that places a module, as the caller's branch sees it. */
export interface ModulePagePlacement {
  readonly pageId: string;
  readonly path: string;
  readonly title: string;
}

/** One placement of a module, as the caller's branch sees it. */
export interface ModulePlacementRow {
  readonly moduleId: string;
  readonly pageId: string;
  readonly path: string;
  readonly title: string;
  readonly slug: string;
  readonly templateId: string;
  readonly blockName: string;
}

/**
 * The placements of each of `moduleIds` as `branchId` sees them, in one
 * statement: live `page_modules` of the pages the branch has no pending
 * layout for, plus the blocks of the branch's newest pending layouts, minus
 * the pages the branch deleted — the view the preview renders.
 *
 * Every step walks an index from the named module, never the draft: a
 * pending layout is reached through its reference row (migration 0592) and
 * the head row beside it, and it counts only when no newer head row of the
 * page exists, so a state another chat has since replaced is ignored. The
 * worst case is a walk over the module's own placements.
 *
 * @param limitPerModule stop each module's walk after this many rows, in no
 *   particular order. Without it, every placement of every module.
 */
export async function placementRowsOfModules(
  tx: TransactionRunner,
  branchId: string | null,
  moduleIds: readonly string[],
  limitPerModule?: number,
): Promise<ModulePlacementRow[]> {
  if (moduleIds.length === 0) return [];
  const limit = limitPerModule === undefined ? sql`` : sql`LIMIT ${limitPerModule}`;
  const visible = branchId
    ? sql`(p.chat_branch_id IS NULL OR p.chat_branch_id = ${branchId}::uuid)`
    : sql`p.chat_branch_id IS NULL`;
  // The head probes are scalar subqueries on purpose: as NOT EXISTS the
  // planner may hash them, which reads the whole draft's head to answer for
  // a few pages. The pending arm goes first: with a limit it is what stops
  // the walk, while live rows superseded by pending layouts yield nothing.
  const placed = branchId
    ? sql`
        SELECT d.entity_id AS page_id, block.value->>'blockName' AS block_name
          FROM page_layout_snapshot_refs r
          JOIN draft_pending_entities d ON d.snapshot_row_id = r.snapshot_row_id
          JOIN page_layout_snapshots es ON es.id = d.snapshot_row_id
         CROSS JOIN LATERAL jsonb_array_elements(es.state->'blocks') AS block(value)
         CROSS JOIN LATERAL jsonb_array_elements_text(block.value->'moduleIds') AS placed(id)
         WHERE r.ref_kind = 'id' AND r.ref = m.id::text
           AND d.chat_branch_id = ${branchId}::uuid AND d.entity_kind = 'pageLayout'
           AND placed.id = m.id::text
           AND (SELECT true FROM draft_pending_entities h
                 WHERE h.chat_branch_id = d.chat_branch_id
                   AND h.entity_kind = d.entity_kind AND h.entity_id = d.entity_id
                   AND (h.header_created_at, h.row_created_at, h.snapshot_row_id)
                     > (d.header_created_at, d.row_created_at, d.snapshot_row_id)
                 LIMIT 1) IS NULL
        UNION ALL
        SELECT pm.page_id, pm.block_name
          FROM page_modules pm
         WHERE pm.module_id = m.id
           AND (SELECT true FROM draft_pending_entities h
                 WHERE h.chat_branch_id = ${branchId}::uuid
                   AND h.entity_kind = 'pageLayout' AND h.entity_id = pm.page_id
                 LIMIT 1) IS NULL`
    : sql`SELECT pm.page_id, pm.block_name FROM page_modules pm WHERE pm.module_id = m.id`;
  const notDeletedOnBranch = branchId
    ? sql`AND NOT COALESCE((
        SELECT (ps.state->>'deletedAt') IS NOT NULL
          FROM draft_pending_entities h
          JOIN page_snapshots ps ON ps.id = h.snapshot_row_id
         WHERE h.chat_branch_id = ${branchId}::uuid
           AND h.entity_kind = 'page' AND h.entity_id = x.page_id
         ORDER BY h.header_created_at DESC, h.row_created_at DESC, h.snapshot_row_id DESC
         LIMIT 1), false)`
    : sql``;
  const rows = (await tx.execute(sql`
    SELECT m.id::text AS module_id, y.page_id::text AS page_id, y.block_name,
           y.path, y.title, y.slug, y.template_id::text AS template_id
      FROM unnest(${uuidArray(moduleIds)}) AS m(id)
     CROSS JOIN LATERAL (
       SELECT x.page_id, x.block_name, p.current_path AS path, p.title, p.slug, p.template_id
         FROM (${placed}) x
         JOIN pages p ON p.id = x.page_id
        WHERE p.deleted_at IS NULL AND ${visible} ${notDeletedOnBranch}
        ${limit}
     ) y
  `)) as unknown as {
    module_id: string;
    page_id: string;
    block_name: string;
    path: string;
    title: string;
    slug: string;
    template_id: string;
  }[];
  return rows.map((r) => ({
    moduleId: r.module_id,
    pageId: r.page_id,
    path: r.path,
    title: r.title,
    slug: r.slug,
    templateId: r.template_id,
    blockName: r.block_name,
  }));
}

/**
 * The pages that place each of `moduleIds` as `branchId` sees them
 * ({@link placementRowsOfModules}, one row per page, sorted by path).
 * Shared by the delete guard and content-instance reach (#627) so both
 * follow the branch the same way. Every requested id is present (empty when
 * unplaced).
 */
export async function findModulePagePlacements(
  tx: TransactionRunner,
  branchId: string | null,
  moduleIds: readonly string[],
): Promise<Map<string, ModulePagePlacement[]>> {
  const pagesByModule = new Map<string, Map<string, ModulePagePlacement>>();
  for (const id of moduleIds) pagesByModule.set(id, new Map());
  if (moduleIds.length === 0) return new Map();
  for (const r of await placementRowsOfModules(tx, branchId, moduleIds)) {
    pagesByModule
      .get(r.moduleId)
      ?.set(r.pageId, { pageId: r.pageId, path: r.path, title: r.title });
  }
  const out = new Map<string, ModulePagePlacement[]>();
  for (const [moduleId, pages] of pagesByModule) {
    out.set(
      moduleId,
      [...pages.values()].sort((a, b) => a.path.localeCompare(b.path)),
    );
  }
  return out;
}

/**
 * Layouts and parent modules that hold each of `moduleIds`:
 * {@link ModulePlacements} without the pages. Every requested id is present.
 *
 * @param nestedLimitPerModule read at most this many nesting instances per
 *   module, for a caller that names parents rather than counting them.
 */
export async function findModuleHolders(
  tx: TransactionRunner,
  branchId: string | null,
  moduleIds: readonly string[],
  nestedLimitPerModule?: number,
): Promise<Map<string, Pick<ModulePlacements, "layouts" | "nestedIn">>> {
  const layoutsByModule = new Map<string, Set<string>>();
  for (const id of moduleIds) layoutsByModule.set(id, new Set());

  const layoutRows = (await tx.execute(sql`
    SELECT DISTINCT lm.module_id::text AS module_id, l.slug
      FROM (${effectiveLayoutModulesSql(branchId)}) lm
      JOIN layouts l ON l.id = lm.layout_id
     WHERE lm.module_id = ANY(${uuidArray(moduleIds)}) AND l.deleted_at IS NULL
  `)) as unknown as { module_id: string; slug: string }[];
  for (const r of layoutRows) layoutsByModule.get(r.module_id)?.add(r.slug);

  // Nested references from content instances (live + this branch's view).
  const nestedByModule = new Map<string, Set<string>>();
  const nesting = await findContentInstancesContaining(
    tx,
    branchId,
    idNeedles(moduleIds),
    nestedLimitPerModule,
  );
  const parentIds = new Set<string>();
  for (const ref of nesting) {
    for (const id of moduleIds) {
      if (ref.moduleId === id || !ref.valuesText.includes(id)) continue;
      const set = nestedByModule.get(id) ?? new Set<string>();
      set.add(ref.moduleId);
      nestedByModule.set(id, set);
      parentIds.add(ref.moduleId);
    }
  }
  const parentSlugs = new Map<string, string>();
  if (parentIds.size > 0) {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug FROM modules
       WHERE id = ANY(${uuidArray([...parentIds])}) AND deleted_at IS NULL
    `)) as unknown as { id: string; slug: string }[];
    for (const r of rows) parentSlugs.set(r.id, r.slug);
    // …and one this chat deleted (branched) no longer renders it either.
    if (branchId) {
      const branchedParents = await loadBranchedModuleStates(tx, branchId, [...parentIds]);
      for (const [id, state] of branchedParents) if (state.deletedAt) parentSlugs.delete(id);
    }
  }

  const out = new Map<string, Pick<ModulePlacements, "layouts" | "nestedIn">>();
  for (const id of moduleIds) {
    out.set(id, {
      layouts: [...(layoutsByModule.get(id) ?? [])].sort(),
      // A parent that is itself deleted no longer renders the child.
      nestedIn: [...(nestedByModule.get(id) ?? [])]
        .flatMap((parentId) => {
          const slug = parentSlugs.get(parentId);
          return slug === undefined ? [] : [slug];
        })
        .sort(),
    });
  }
  return out;
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
  if (moduleIds.length === 0) return new Map();
  const branchId = ctx.chatBranchId ?? null;
  const pagesByModule = await findModulePagePlacements(tx, branchId, moduleIds);
  const holders = await findModuleHolders(tx, branchId, moduleIds);
  const out = new Map<string, ModulePlacements>();
  for (const id of moduleIds) {
    out.set(id, {
      pages: [...new Set((pagesByModule.get(id) ?? []).map((p) => p.path))].sort(),
      layouts: holders.get(id)?.layouts ?? [],
      nestedIn: holders.get(id)?.nestedIn ?? [],
    });
  }
  return out;
}

/** Most ids one `modules.list_usage` call takes (`list_modules` splits a longer catalog). */
export const MAX_USAGE_MODULES = 1000;

/** How many page placements a usage row counts before it says "100+". */
export const MODULE_USAGE_COUNT_CAP = 100;

/** Sample pages per module in a usage row. */
const USAGE_SAMPLE_PATHS = 3;

/** Nesting instances per module a usage row reads: enough to name parents. */
const USAGE_NESTED_INSTANCES = 20;

/** What the catalog says about where one module is used ({@link usageOfModules}). */
export interface ModuleUsage {
  readonly moduleId: string;
  /** Page placements, at most {@link MODULE_USAGE_COUNT_CAP}. */
  readonly placementCount: number;
  /** More page placements exist than `placementCount`. */
  readonly placementCountCapped: boolean;
  /** Sample page paths, sorted. */
  readonly samplePaths: readonly string[];
  readonly layouts: readonly string[];
  /** Slugs of parent modules (a sample when many instances nest the module). */
  readonly nestedIn: readonly string[];
}

/** One module's usage is "unplaced": no page, layout or parent — what the delete guard concludes. */
export function isUnplaced(u: ModuleUsage | undefined): boolean {
  return (
    u === undefined || (u.placementCount === 0 && u.layouts.length === 0 && u.nestedIn.length === 0)
  );
}

/**
 * The usage signal of the catalog: the view of {@link findModulePlacements}
 * bounded per module, so a read costs the modules named however many pages
 * place them. Every requested id is present.
 */
export async function usageOfModules(
  tx: TransactionRunner,
  ctx: Pick<ExecutionContext, "chatBranchId">,
  moduleIds: readonly string[],
): Promise<ModuleUsage[]> {
  const branchId = ctx.chatBranchId ?? null;
  const rows = await placementRowsOfModules(tx, branchId, moduleIds, MODULE_USAGE_COUNT_CAP + 1);
  const holders = await findModuleHolders(tx, branchId, moduleIds, USAGE_NESTED_INSTANCES);
  const byModule = new Map<string, ModulePlacementRow[]>();
  for (const r of rows) {
    const list = byModule.get(r.moduleId) ?? [];
    list.push(r);
    byModule.set(r.moduleId, list);
  }
  return moduleIds.map((moduleId) => {
    const placed = byModule.get(moduleId) ?? [];
    return {
      moduleId,
      placementCount: Math.min(placed.length, MODULE_USAGE_COUNT_CAP),
      placementCountCapped: placed.length > MODULE_USAGE_COUNT_CAP,
      samplePaths: [...new Set(placed.map((p) => p.path))].sort().slice(0, USAGE_SAMPLE_PATHS),
      layouts: holders.get(moduleId)?.layouts ?? [],
      nestedIn: holders.get(moduleId)?.nestedIn ?? [],
    };
  });
}

/** True when the module is placed anywhere the caller can see. */
export function isPlaced(p: ModulePlacements | undefined): boolean {
  return p !== undefined && (p.pages.length > 0 || p.layouts.length > 0 || p.nestedIn.length > 0);
}

/** "3 page(s) (/, /about, /docs/setup) and layout(s) site-default" — for error copy. */
export function describePlacements(p: ModulePlacements): string {
  const parts: string[] = [];
  if (p.pages.length > 0) {
    const sample = p.pages.slice(0, 5).join(", ");
    parts.push(`${p.pages.length} page(s) (${sample}${p.pages.length > 5 ? ", …" : ""})`);
  }
  if (p.layouts.length > 0) parts.push(`layout(s) ${p.layouts.join(", ")}`);
  if (p.nestedIn.length > 0) {
    parts.push(`the content of module(s) ${p.nestedIn.join(", ")} (nested module field)`);
  }
  return parts.join(" and ");
}
