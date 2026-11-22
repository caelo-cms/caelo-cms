// SPDX-License-Identifier: MPL-2.0

/**
 * Where a content instance renders, as the caller's branch sees the site
 * (#627, #1067).
 *
 * An instance reaches a page three ways, and only the first has a
 * relational row:
 *
 *   1. a placement (`page_modules.content_instance_id`, or the branch's
 *      pending page layout);
 *   2. a parent content instance whose `module` / `module-list` field (or
 *      a local list entry's `module` field) lists it — it renders wherever
 *      that parent renders, at any depth;
 *   3. a module whose field DEFAULT lists it (layout chrome has only
 *      defaults) or a shared list whose entries embed it.
 *
 * An instance with no placement of its own is therefore not an orphan
 * when anything in (2) or (3) still shows it. Every consumer that asks
 * "is this instance used, and where?" — the delete guard, `get` / `list`
 * usage, the `set_values` blast radius and its `page.updated` events, the
 * publish impact of a chat's edits — reads {@link loadContentInstanceReach}
 * so they agree with each other and with the renderer.
 */

import { type TransactionRunner, textArray, uuidArray } from "@caelo-cms/query-api";
import { collectNestedRefs, rendersFieldDefault, type TemplateField } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { headOverlaySql, pendingRefCandidatesSql } from "../../draft.js";
import { type ListEntityView, loadListEntities } from "../../lists/store.js";
import { loadBranchedModuleStates } from "../../snapshots/index.js";
import type { PageLayoutState } from "../../snapshots/state.js";
import {
  type ContentInstanceRef,
  findContentInstancesContaining,
  findContentInstancesOfModules,
  idNeedles,
} from "./content-instance-refs.js";
import { effectiveLayoutModulesSql } from "./layout-overlay.js";
import { findModulePagePlacements, placementRowsOfModules } from "./module-placements.js";

/** One placement bound to a content_instance, as the caller sees it. */
export interface PlacementInView {
  readonly contentInstanceId: string;
  readonly pageId: string;
  readonly path: string;
  readonly pageSlug: string;
  readonly pageTitle: string;
  /** The page is soft-deleted; its placement still holds the instance (restore). */
  readonly pageDeleted: boolean;
  readonly blockName: string;
  readonly position: number;
  readonly syncMode: "synced" | "unsynced";
}

type Tx = TransactionRunner;

/**
 * The placements bound to any of `contentInstanceIds` as `branchId` sees
 * them: live `page_modules`, with every page the branch has a pending
 * layout snapshot for replaced by that snapshot. PR #947 review — in a
 * chat, `fork_placement_content` rebinds only the branch layout, so a
 * live-only view kept refusing the delete the refusal told the AI to
 * retry. #1067 — every placement read (get, list's placementCount,
 * set_values' blast radius, delete's guard) goes through here so they
 * agree with each other and with the preview. Ordered by path so
 * messages name pages deterministically.
 *
 * @param bound read at most `perInstance` live placements per instance and
 *   add every instance that has more to `capped`, for a caller that only
 *   needs to know whether an instance shows on more pages than that.
 */
export async function listPlacementsInView(
  tx: Tx,
  contentInstanceIds: readonly string[],
  branchId: string | null,
  bound?: { readonly perInstance: number; readonly capped: Set<string> },
): Promise<PlacementInView[]> {
  if (contentInstanceIds.length === 0) return [];
  const idList = uuidArray(contentInstanceIds);
  const columns = sql`pm.content_instance_id::text AS content_instance_id, pm.page_id::text AS page_id,
           p.current_path AS path, p.slug AS page_slug, p.title AS page_title,
           (p.deleted_at IS NOT NULL) AS page_deleted, pm.block_name, pm.position, pm.sync_mode`;
  const live = (await tx.execute(
    bound === undefined
      ? sql`
    SELECT ${columns}
    FROM page_modules pm
    JOIN pages p ON p.id = pm.page_id
    WHERE pm.content_instance_id = ANY(${idList})`
      : sql`
    SELECT x.* FROM unnest(${idList}) AS c(id)
    CROSS JOIN LATERAL (
      SELECT ${columns}
        FROM page_modules pm
        JOIN pages p ON p.id = pm.page_id
       WHERE pm.content_instance_id = c.id
       LIMIT ${bound.perInstance + 1}) x`,
  )) as unknown as {
    content_instance_id: string;
    page_id: string;
    path: string;
    page_slug: string;
    page_title: string;
    page_deleted: boolean;
    block_name: string;
    position: number;
    sync_mode: "synced" | "unsynced";
  }[];
  if (bound !== undefined) {
    const perInstance = new Map<string, number>();
    for (const r of live) {
      perInstance.set(r.content_instance_id, (perInstance.get(r.content_instance_id) ?? 0) + 1);
    }
    for (const [id, n] of perInstance) if (n > bound.perInstance) bound.capped.add(id);
  }
  const placements: PlacementInView[] = live.map((r) => ({
    contentInstanceId: r.content_instance_id,
    pageId: r.page_id,
    path: r.path,
    pageSlug: r.page_slug,
    pageTitle: r.page_title,
    pageDeleted: r.page_deleted,
    blockName: r.block_name,
    position: r.position,
    syncMode: r.sync_mode,
  }));
  if (branchId === null) return sortByPath(placements);

  // The newest pending layout of every page that may hold a wanted
  // instance on the branch — the same row
  // `loadPageLayoutStateWithBranchOverlay` picks: the pages of the live
  // placements (a pending layout supersedes them) and the pages whose
  // pending layout references one (the snapshot reference table, 0592).
  // Never every pending layout of the draft.
  const pendingPages = (await tx.execute(
    pendingRefCandidatesSql({ kind: "pageLayout", branchId, ids: contentInstanceIds }),
  )) as unknown as { entity_id: string }[];
  const pageIds = [
    ...new Set([...placements.map((p) => p.pageId), ...pendingPages.map((r) => r.entity_id)]),
  ];
  const overlaid =
    pageIds.length === 0
      ? []
      : ((await tx.execute(sql`
    SELECT h.entity_id AS page_id, p.current_path AS path, p.slug AS page_slug,
           p.title AS page_title, (p.deleted_at IS NOT NULL) AS page_deleted, h.state
      FROM (${headOverlaySql({
        kind: "pageLayout",
        table: "page_layout_snapshots",
        branchId,
        ids: pageIds,
      })}) h
      JOIN pages p ON p.id = h.entity_id::uuid
  `)) as unknown as {
          page_id: string;
          path: string;
          page_slug: string;
          page_title: string;
          page_deleted: boolean;
          state: unknown;
        }[]);
  const wanted = new Set(contentInstanceIds);
  const overlaidIds = new Set(overlaid.map((r) => r.page_id));
  const inView = placements.filter((p) => !overlaidIds.has(p.pageId));
  for (const page of overlaid) {
    const layout = page.state as PageLayoutState;
    for (const block of layout.blocks) {
      if (!block.placements) {
        throw new Error(
          `content_instances: branch layout of page ${page.page_id} block ${block.blockName} has no placements — the snapshot predates v0.12; undo that chat's layout change and redo it`,
        );
      }
      block.placements.forEach((pl, position) => {
        if (!wanted.has(pl.contentInstanceId)) return;
        inView.push({
          contentInstanceId: pl.contentInstanceId,
          pageId: page.page_id,
          path: page.path,
          pageSlug: page.page_slug,
          pageTitle: page.page_title,
          pageDeleted: page.page_deleted,
          blockName: block.blockName,
          position,
          syncMode: pl.syncMode,
        });
      });
    }
  }
  return sortByPath(inView);
}

/**
 * The instances of `contentInstanceIds` that a placement on a page other
 * than `pageId` binds, as `branchId` sees the site: the instances of
 * {@link listPlacementsInView} with a placement off `pageId`, which is all
 * `page_module_content.list_for_page` needs to know (#1674). That op runs
 * once per translated page, and listing every placement made it read all
 * pages a shared instance sits on, with their pending layouts. Each of the
 * two reads here stops at the first page it finds per instance: an
 * instance shared by 50,000 pages, pending or live, costs one row. Only
 * proving a "no" reads further: an instance whose every other page has a
 * pending layout without it is checked page by page.
 *
 * Both reads are `CROSS JOIN LATERAL (… LIMIT 1)`, not `EXISTS`: under
 * RLS the planner estimates the policy terms at a fraction of the rows and
 * turned an `EXISTS` into a hash semi join over every reference of the
 * instances (240,000 buffers on the rows-read fixture, 30 this way). A
 * lateral subquery with a limit is never flattened into a join.
 */
export async function placedOutsidePage(
  tx: Tx,
  contentInstanceIds: readonly string[],
  branchId: string | null,
  pageId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(contentInstanceIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return out;
  if (branchId !== null) {
    // A pending layout of another page that places one. The reference
    // index (0592) names the pages whose pending rows reference it; for
    // each, the page's head (its newest pending layout row, the order
    // `headOverlaySql` reads) decides whether a placement binds it. Asking
    // the head of each referencing row, not whether that row is the head,
    // answers at the first page: a page several chats changed has older
    // rows that need not be the head.
    // The ids go in as text: `r.ref = c.ref` is then a leakproof text
    // comparison, an index condition under the refs table's RLS policy,
    // where `r.ref = c.id::text` (a uuid cast, not leakproof) was only a
    // filter over every id reference of the site (#1297 rule 2).
    const pending = (await tx.execute(sql`
      SELECT c.ref AS id FROM unnest(${textArray(ids)}) AS c(ref)
       CROSS JOIN LATERAL (
         SELECT 1 FROM page_layout_snapshot_refs r
           JOIN draft_pending_entities d ON d.snapshot_row_id = r.snapshot_row_id
          WHERE r.ref_kind = 'id' AND r.ref = c.ref
            AND d.chat_branch_id = ${branchId}::uuid AND d.entity_kind = 'pageLayout'
            AND d.entity_id <> ${pageId}::uuid
            AND EXISTS (
              SELECT 1
                FROM (SELECT h.snapshot_row_id FROM draft_pending_entities h
                       WHERE h.chat_branch_id = d.chat_branch_id AND h.entity_kind = d.entity_kind
                         AND h.entity_id = d.entity_id AND h.entity_sub = d.entity_sub
                       ORDER BY h.header_created_at DESC, h.row_created_at DESC,
                                h.snapshot_row_id DESC
                       LIMIT 1) head
                JOIN page_layout_snapshots es ON es.id = head.snapshot_row_id
                JOIN pages p ON p.id = d.entity_id
               WHERE es.state @> jsonb_build_object('blocks', jsonb_build_array(
                       jsonb_build_object('placements', jsonb_build_array(
                         jsonb_build_object('contentInstanceId', c.ref))))))
          LIMIT 1) hit
    `)) as unknown as { id: string }[];
    for (const r of pending) out.add(r.id);
  }
  const rest = ids.filter((id) => !out.has(id));
  if (rest.length === 0) return out;
  // A live placement on another page, unless that page has a pending
  // layout: the branch shows that layout instead (`listPlacementsInView`).
  const notOverlaid = branchId
    ? sql`AND NOT EXISTS (
        SELECT 1 FROM draft_pending_entities d
         WHERE d.chat_branch_id = ${branchId}::uuid AND d.entity_kind = 'pageLayout'
           AND d.entity_id = pm.page_id)`
    : sql``;
  const live = (await tx.execute(sql`
    SELECT c.id::text AS id FROM unnest(${uuidArray(rest)}) AS c(id)
     CROSS JOIN LATERAL (
       SELECT 1 FROM page_modules pm JOIN pages p ON p.id = pm.page_id
        WHERE pm.content_instance_id = c.id AND pm.page_id <> ${pageId}::uuid ${notOverlaid}
        LIMIT 1) hit
  `)) as unknown as { id: string }[];
  for (const r of live) out.add(r.id);
  return out;
}

function sortByPath(placements: PlacementInView[]): PlacementInView[] {
  return placements.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.blockName.localeCompare(b.blockName) ||
      a.position - b.position,
  );
}

/** Placement count per instance id, as the caller sees it (absent = 0). */
export async function countPlacementsInView(
  tx: Tx,
  contentInstanceIds: readonly string[],
  branchId: string | null,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const p of await listPlacementsInView(tx, contentInstanceIds, branchId)) {
    counts.set(p.contentInstanceId, (counts.get(p.contentInstanceId) ?? 0) + 1);
  }
  return counts;
}

/**
 * #1269 — {@link countPlacementsInView} capped at `cap` per instance, for a
 * caller that only needs to know whether an instance has `cap` or more
 * placements (the repeated-value hint: private or shared). Reads at most
 * `cap` live placements per instance on pages without a pending layout on
 * the branch, plus the placements of the branch's pending layouts that
 * reference one: a shared instance on 50,000 pages costs `cap` rows, not
 * its placements. Equal to min(countPlacementsInView, cap).
 */
export async function countPlacementsAtMost(
  tx: Tx,
  contentInstanceIds: readonly string[],
  branchId: string | null,
  cap: number,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (contentInstanceIds.length === 0) return counts;
  const notOverlaid = branchId
    ? sql`AND NOT EXISTS (
        SELECT 1 FROM draft_pending_entities d
         WHERE d.chat_branch_id = ${branchId}::uuid AND d.entity_kind = 'pageLayout'
           AND d.entity_id = pm.page_id)`
    : sql``;
  const live = (await tx.execute(sql`
    SELECT c.id::text AS content_instance_id, count(x.page_id)::int AS n
      FROM unnest(${uuidArray(contentInstanceIds)}) AS c(id)
      CROSS JOIN LATERAL (
        SELECT pm.page_id FROM page_modules pm
         WHERE pm.content_instance_id = c.id ${notOverlaid}
         LIMIT ${cap}) x
     GROUP BY c.id
  `)) as unknown as { content_instance_id: string; n: number }[];
  for (const r of live) counts.set(r.content_instance_id, r.n);
  if (branchId !== null) {
    const pendingPages = (await tx.execute(
      pendingRefCandidatesSql({ kind: "pageLayout", branchId, ids: contentInstanceIds }),
    )) as unknown as { entity_id: string }[];
    if (pendingPages.length > 0) {
      const wanted = new Set(contentInstanceIds);
      const overlaid = (await tx.execute(
        headOverlaySql({
          kind: "pageLayout",
          table: "page_layout_snapshots",
          branchId,
          ids: pendingPages.map((r) => r.entity_id),
        }),
      )) as unknown as { entity_id: string; state: unknown }[];
      for (const page of overlaid) {
        for (const block of (page.state as PageLayoutState).blocks) {
          for (const pl of block.placements ?? []) {
            if (!wanted.has(pl.contentInstanceId)) continue;
            counts.set(pl.contentInstanceId, (counts.get(pl.contentInstanceId) ?? 0) + 1);
          }
        }
      }
    }
  }
  for (const [id, n] of counts) counts.set(id, Math.min(n, cap));
  return counts;
}

/**
 * The content instances (live + the caller's branch view, deleted ones
 * excluded) that list each of `contentInstanceIds` in a `module` /
 * `module-list` field, keyed by child id. A child with no placement of
 * its own still renders wherever such a parent renders — it is not an
 * orphan (#1067). The indexed id match is confirmed against the parsed
 * refs.
 */
export async function nestedParentsInView(
  tx: Tx,
  branchId: string | null,
  contentInstanceIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (contentInstanceIds.length === 0) return out;
  const wanted = new Set(contentInstanceIds);
  const candidates = await findContentInstancesContaining(tx, branchId, idNeedles(wanted));
  for (const c of candidates) {
    const refs = collectNestedRefs(JSON.parse(c.valuesText) as Record<string, unknown>);
    for (const childId of new Set(refs.map((r) => r.contentInstanceId))) {
      if (childId === c.contentInstanceId || !wanted.has(childId)) continue;
      const parents = out.get(childId) ?? [];
      parents.push(c.contentInstanceId);
      out.set(childId, parents);
    }
  }
  return out;
}

/**
 * The renderer stops at nesting depth 8, so a parent more than 8 levels
 * up never shows the instance: the upward walk stops there too.
 */
const MAX_NESTING_DEPTH = 8;

/** A module whose field default shows the instance (layout chrome has only defaults). */
export interface ModuleParent {
  readonly moduleId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly field: string;
}

/** A shared list whose entries embed the instance in a `module` field. */
export interface ListParent {
  readonly listId: string;
  readonly slug: string;
  readonly name: string;
}

/** A page the instance renders on. */
export interface ReachPage {
  readonly pageId: string;
  readonly path: string;
  readonly title: string;
}

/** Where one content instance is used and renders, as the caller sees it. */
export interface ContentInstanceReach {
  /** Its own placements (soft-deleted pages included: a restore brings them back). */
  readonly placements: readonly PlacementInView[];
  /** Instances that list it directly in a `module` / `module-list` field. */
  readonly parentInstances: readonly string[];
  /** Modules whose field default lists it directly. */
  readonly parentModules: readonly ModuleParent[];
  /** Shared lists whose entries embed it directly. */
  readonly parentLists: readonly ListParent[];
  /**
   * Every live page it renders on: its own placements, the placements of
   * every ancestor instance, and the page placements of every module whose
   * default shows it or an ancestor. Sorted by path.
   */
  readonly pages: readonly ReachPage[];
  /**
   * Layouts whose chrome module shows it (or an ancestor) through a field
   * default — it renders on every page of those layouts.
   */
  readonly chromeLayouts: readonly { readonly layoutId: string; readonly slug: string }[];
  /** Shared lists that show it or an ancestor — it renders wherever they render. */
  readonly viaLists: readonly ListParent[];
  /**
   * A bounded read (`placementsPerSource`) stopped before the end for it,
   * an ancestor or a module whose default shows it: it renders on more
   * pages than `pages` lists, and `placements` is a sample. Always false
   * for an unbounded read.
   */
  readonly morePages: boolean;
}

/** Direct parents of any kind. */
export function parentCountOf(r: ContentInstanceReach): number {
  return r.parentInstances.length + r.parentModules.length + r.parentLists.length;
}

/** No placement and nothing that shows it: deleting it changes no render. */
export function isOrphan(r: ContentInstanceReach): boolean {
  return r.placements.length === 0 && parentCountOf(r) === 0;
}

/**
 * Reach of each of `contentInstanceIds`, keyed by id (every id present).
 *
 * Walks parent instances upward (bounded by the renderer's depth), then
 * reads module defaults and shared lists once for the whole closure, and
 * the placements of every instance in it in one call.
 *
 * @param options.placementsPerSource read at most this many placements per
 *   instance and per module default parent, and say `morePages` past it:
 *   for a caller that only needs to know whether an instance shows on one
 *   page or many (the change lists, part-placement.ts), so an instance
 *   synced on every page costs that many rows, not the site. The delete
 *   guard, the blast radius and the incremental Stage read everything.
 */
export async function loadContentInstanceReach(
  tx: Tx,
  branchId: string | null,
  contentInstanceIds: readonly string[],
  options: { readonly placementsPerSource?: number } = {},
): Promise<Map<string, ContentInstanceReach>> {
  const bound = options.placementsPerSource;
  const out = new Map<string, ContentInstanceReach>();
  const ids = [...new Set(contentInstanceIds)];
  if (ids.length === 0) return out;

  // Module field defaults that list an instance of the walk, read per
  // level for the frontier: the walk below and the module-default reach
  // both read it.
  const moduleParents = new Map<string, DefaultParent[]>();

  // 1. Parent instances, transitively, one indexed lookup per level
  // (content_instance_refs, #1287). An instance whose module's
  // field default lists the child, and which leaves that field unset,
  // renders the child too (the renderer falls back to the default), so it
  // is walked as a parent as well — `parentsOf` keeps only the stored
  // references, `shownBy` every parent the walk follows.
  const parentsOf = new Map<string, string[]>();
  const shownBy = new Map<string, string[]>();
  const instancesByModule = new Map<string, ContentInstanceRef[]>();
  let frontier = ids;
  for (let depth = 0; depth < MAX_NESTING_DEPTH && frontier.length > 0; depth += 1) {
    const found = await nestedParentsInView(tx, branchId, frontier);
    for (const [child, parents] of await moduleDefaultParents(tx, branchId, frontier)) {
      moduleParents.set(child, parents);
    }
    const unloaded = new Set<string>();
    for (const id of frontier) {
      for (const m of moduleParents.get(id) ?? []) {
        if (!instancesByModule.has(m.moduleId)) unloaded.add(m.moduleId);
      }
    }
    if (unloaded.size > 0) {
      for (const moduleId of unloaded) instancesByModule.set(moduleId, []);
      for (const ci of await findContentInstancesOfModules(tx, branchId, [...unloaded])) {
        instancesByModule.get(ci.moduleId)?.push(ci);
      }
    }
    const next = new Set<string>();
    for (const id of frontier) {
      const parents = found.get(id) ?? [];
      parentsOf.set(id, parents);
      const shown = new Set(parents);
      for (const m of moduleParents.get(id) ?? []) {
        for (const ci of instancesByModule.get(m.moduleId) ?? []) {
          if (ci.contentInstanceId === id) continue;
          const values = JSON.parse(ci.valuesText) as Record<string, unknown>;
          if (rendersFieldDefault(m.fieldSpec, values)) shown.add(ci.contentInstanceId);
        }
      }
      shownBy.set(id, [...shown]);
      for (const p of shown) if (!parentsOf.has(p)) next.add(p);
    }
    frontier = [...next];
  }
  const closure = [...parentsOf.keys()];
  const inClosure = new Set(closure);

  // 2. Shared lists that show any instance of the closure: the lists whose
  // items reference one (the list reference tables, 0595), confirmed on
  // their newest items.
  const listParents = new Map<string, ListParent[]>();
  for (const list of await listsReferencing(tx, branchId, closure)) {
    const parent = { listId: list.id, slug: list.state.slug, name: list.state.name };
    const children = new Set(
      collectNestedRefs({ items: list.state.items }).map((r) => r.contentInstanceId),
    );
    for (const child of children) {
      if (!inClosure.has(child)) continue;
      listParents.set(child, [...(listParents.get(child) ?? []), parent]);
    }
  }

  // 3. Where the closure renders: placements, and the pages / layouts of parent modules.
  const cappedInstances = new Set<string>();
  const placements = await listPlacementsInView(
    tx,
    closure,
    branchId,
    bound === undefined ? undefined : { perInstance: bound, capped: cappedInstances },
  );
  const parentModuleIds = [
    ...new Set(closure.flatMap((id) => moduleParents.get(id) ?? []).map((m) => m.moduleId)),
  ];
  // A module default renders on a placement whose own content leaves that
  // field empty, so these are the pages it MAY render on — the right side
  // to err on for a blast radius — as the branch's page layouts place it.
  const cappedModules = new Set<string>();
  const modulePages =
    bound === undefined
      ? await findModulePagePlacements(tx, branchId, parentModuleIds)
      : await boundedModulePages(tx, branchId, parentModuleIds, bound, cappedModules);
  const moduleLayouts = await layoutsPlacingModules(tx, branchId, parentModuleIds);

  for (const id of ids) {
    const ancestors = new Set<string>([id]);
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      for (const p of shownBy.get(cur) ?? []) {
        if (ancestors.has(p)) continue;
        ancestors.add(p);
        stack.push(p);
      }
    }
    const pages = new Map<string, ReachPage>();
    for (const p of placements) {
      if (!ancestors.has(p.contentInstanceId) || p.pageDeleted) continue;
      pages.set(p.pageId, { pageId: p.pageId, path: p.path, title: p.pageTitle });
    }
    const layouts = new Map<string, { layoutId: string; slug: string }>();
    const viaLists = new Map<string, ListParent>();
    let morePages = false;
    for (const a of ancestors) {
      if (cappedInstances.has(a)) morePages = true;
      for (const m of moduleParents.get(a) ?? []) {
        if (cappedModules.has(m.moduleId)) morePages = true;
        for (const page of modulePages.get(m.moduleId) ?? []) pages.set(page.pageId, page);
        for (const l of moduleLayouts.get(m.moduleId) ?? []) layouts.set(l.layoutId, l);
      }
      for (const l of listParents.get(a) ?? []) viaLists.set(l.listId, l);
    }
    out.set(id, {
      placements: placements.filter((p) => p.contentInstanceId === id),
      parentInstances: parentsOf.get(id) ?? [],
      parentModules: (moduleParents.get(id) ?? []).map(({ fieldSpec: _spec, ...m }) => m),
      parentLists: listParents.get(id) ?? [],
      pages: [...pages.values()].sort((a, b) => a.path.localeCompare(b.path)),
      chromeLayouts: [...layouts.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
      viaLists: [...viaLists.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
      morePages,
    });
  }
  return out;
}

/**
 * {@link findModulePagePlacements} reading at most `bound` placements per
 * module; every module with more goes into `capped`.
 */
async function boundedModulePages(
  tx: Tx,
  branchId: string | null,
  moduleIds: readonly string[],
  bound: number,
  capped: Set<string>,
): Promise<Map<string, ReachPage[]>> {
  const rows = await placementRowsOfModules(tx, branchId, moduleIds, bound + 1);
  const rowsOf = new Map<string, number>();
  const pagesOf = new Map<string, Map<string, ReachPage>>();
  for (const r of rows) {
    rowsOf.set(r.moduleId, (rowsOf.get(r.moduleId) ?? 0) + 1);
    const pages = pagesOf.get(r.moduleId) ?? new Map<string, ReachPage>();
    pages.set(r.pageId, { pageId: r.pageId, path: r.path, title: r.title });
    pagesOf.set(r.moduleId, pages);
  }
  for (const [moduleId, n] of rowsOf) if (n > bound) capped.add(moduleId);
  return new Map([...pagesOf].map(([moduleId, pages]) => [moduleId, [...pages.values()]]));
}

/**
 * The lists in the caller's view (deleted ones excluded) whose items may
 * reference one of `ids`: live lists from `list_refs`, and on a branch the
 * pending lists from their snapshot references — a superset the caller
 * confirms on the returned (newest) items.
 */
async function listsReferencing(
  tx: Tx,
  branchId: string | null,
  ids: readonly string[],
): Promise<ListEntityView<"list">[]> {
  const needles = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (needles.length === 0) return [];
  const live = (await tx.execute(sql`
    SELECT DISTINCT list_id::text AS id FROM list_refs
     WHERE ref_kind = 'id' AND ref = ANY(${textArray(needles)})
  `)) as unknown as { id: string }[];
  const pending = branchId
    ? ((await tx.execute(
        pendingRefCandidatesSql({ kind: "list", branchId, ids: needles }),
      )) as unknown as { entity_id: string }[])
    : [];
  const candidateIds = [...new Set([...live.map((r) => r.id), ...pending.map((p) => p.entity_id)])];
  if (candidateIds.length === 0) return [];
  return (await loadListEntities(tx, "list", branchId, { ids: candidateIds })).filter(
    (l) => l.state.deletedAt === null,
  );
}

/** A module default parent, with the field it is the default of. */
interface DefaultParent extends ModuleParent {
  readonly fieldSpec: Pick<TemplateField, "name" | "kind" | "bind">;
}

/**
 * Modules (as the caller sees them) whose field defaults reference one of
 * `childIds`, keyed by child id. The candidates come from the module
 * reference tables (0595): live modules whose fields reference a child,
 * and on a branch the pending modules whose newest state may — so the
 * cost is the matches, never every module or pending module (#1391).
 * Each candidate is confirmed on its newest fields.
 */
async function moduleDefaultParents(
  tx: Tx,
  branchId: string | null,
  childIds: readonly string[],
): Promise<Map<string, DefaultParent[]>> {
  const wanted = new Set(childIds);
  const needles = [...new Set(childIds.map((id) => id.toLowerCase()))];
  if (needles.length === 0) return new Map();
  const visible = branchId
    ? sql`(m.chat_branch_id IS NULL OR m.chat_branch_id = ${branchId}::uuid)`
    : sql`m.chat_branch_id IS NULL`;
  const live = (await tx.execute(sql`
    SELECT m.id::text AS id, m.slug, m.display_name, m.fields
      FROM modules m
     WHERE m.deleted_at IS NULL AND ${visible}
       AND m.id IN (SELECT r.module_id FROM module_refs r
                     WHERE r.ref_kind = 'id' AND r.ref = ANY(${textArray(needles)}))
  `)) as unknown as { id: string; slug: string; display_name: string; fields: unknown }[];
  const candidates = new Map<string, { slug: string; displayName: string; fields: unknown }>();
  for (const r of live) {
    candidates.set(r.id, { slug: r.slug, displayName: r.display_name, fields: r.fields });
  }
  if (branchId) {
    const pending = (await tx.execute(
      pendingRefCandidatesSql({ kind: "module", branchId, ids: needles }),
    )) as unknown as { entity_id: string }[];
    const ids = [...new Set([...candidates.keys(), ...pending.map((p) => p.entity_id)])];
    for (const [id, s] of await loadBranchedModuleStates(tx, branchId, ids)) {
      if (s.deletedAt !== null) {
        candidates.delete(id);
        continue;
      }
      candidates.set(id, { slug: s.slug, displayName: s.displayName, fields: s.fields });
    }
  }
  const out = new Map<string, DefaultParent[]>();
  for (const [moduleId, m] of candidates) {
    if (!Array.isArray(m.fields)) continue;
    for (const f of m.fields as Partial<TemplateField>[]) {
      if (typeof f.name !== "string" || f.default === undefined) continue;
      const children = new Set(
        collectNestedRefs({ [f.name]: f.default }).map((r) => r.contentInstanceId),
      );
      for (const child of children) {
        if (!wanted.has(child)) continue;
        const parent: DefaultParent = {
          moduleId,
          slug: m.slug,
          displayName: m.displayName,
          field: f.name,
          fieldSpec: { name: f.name, kind: f.kind as TemplateField["kind"], bind: f.bind },
        };
        out.set(child, [...(out.get(child) ?? []), parent]);
      }
    }
  }
  return out;
}

/**
 * Layouts whose chrome places any of `moduleIds`, keyed by module id — as
 * the branch sees the chrome (its pending `layout_modules.set` snapshots),
 * the same view the preview renders.
 */
export async function layoutsPlacingModules(
  tx: Tx,
  branchId: string | null,
  moduleIds: readonly string[],
): Promise<Map<string, { layoutId: string; slug: string }[]>> {
  const out = new Map<string, { layoutId: string; slug: string }[]>();
  if (moduleIds.length === 0) return out;
  const visible = branchId
    ? sql`(l.chat_branch_id IS NULL OR l.chat_branch_id = ${branchId}::uuid)`
    : sql`l.chat_branch_id IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT DISTINCT lm.module_id::text AS module_id, l.id::text AS layout_id, l.slug
      FROM (${effectiveLayoutModulesSql(branchId)}) lm
      JOIN layouts l ON l.id = lm.layout_id
     WHERE l.deleted_at IS NULL AND ${visible}
       AND lm.module_id = ANY(${uuidArray(moduleIds)})
  `)) as unknown as { module_id: string; layout_id: string; slug: string }[];
  for (const r of rows) {
    const layout = { layoutId: r.layout_id, slug: r.slug };
    out.set(r.module_id, [...(out.get(r.module_id) ?? []), layout]);
  }
  return out;
}
