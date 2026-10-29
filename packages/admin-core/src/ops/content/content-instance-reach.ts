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

import type { TransactionRunner } from "@caelo-cms/query-api";
import { collectNestedRefs } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../../draft.js";
import { loadListEntities } from "../../lists/store.js";
import { loadBranchedModuleStates } from "../../snapshots/index.js";
import type { PageLayoutState } from "../../snapshots/state.js";
import {
  type ContentInstanceRef,
  findContentInstancesContaining,
  findContentInstancesOfModules,
} from "./content-instance-refs.js";
import { effectiveLayoutModulesSql } from "./layout-overlay.js";
import { findModulePagePlacements } from "./module-placements.js";

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
 */
export async function listPlacementsInView(
  tx: Tx,
  contentInstanceIds: readonly string[],
  branchId: string | null,
): Promise<PlacementInView[]> {
  if (contentInstanceIds.length === 0) return [];
  const idList = sql.join(
    contentInstanceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const live = (await tx.execute(sql`
    SELECT pm.content_instance_id::text AS content_instance_id, pm.page_id::text AS page_id,
           p.current_path AS path, p.slug AS page_slug, p.title AS page_title,
           (p.deleted_at IS NOT NULL) AS page_deleted, pm.block_name, pm.position, pm.sync_mode
    FROM page_modules pm
    JOIN pages p ON p.id = pm.page_id
    WHERE pm.content_instance_id IN (${idList})
  `)) as unknown as {
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

  // The newest pending layout per page the branch reshaped — the same row
  // `loadPageLayoutStateWithBranchOverlay` picks, in one query.
  const overlaid = (await tx.execute(sql`
    SELECT DISTINCT ON (pls.page_id)
           pls.page_id::text AS page_id, p.current_path AS path, p.slug AS page_slug,
           p.title AS page_title, (p.deleted_at IS NOT NULL) AS page_deleted, pls.state
    FROM page_layout_snapshots pls
    JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
    JOIN pages p ON p.id = pls.page_id
    WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
    ORDER BY pls.page_id, ss.created_at DESC
  `)) as unknown as {
    page_id: string;
    path: string;
    page_slug: string;
    page_title: string;
    page_deleted: boolean;
    state: unknown;
  }[];
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

/** Above this many ids the parent scan matches any nested ref instead of OR-ing ids. */
const NESTED_PARENT_ID_NEEDLES_MAX = 20;

/**
 * The content instances (live + the caller's branch view, deleted ones
 * excluded) that list each of `contentInstanceIds` in a `module` /
 * `module-list` field, keyed by child id. A child with no placement of
 * its own still renders wherever such a parent renders — it is not an
 * orphan (#1067). The substring prefilter is confirmed against the
 * parsed refs. `"all"` returns the parents of every nested child (one
 * scan, for a walk over many ids).
 */
export async function nestedParentsInView(
  tx: Tx,
  branchId: string | null,
  contentInstanceIds: readonly string[] | "all",
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (contentInstanceIds.length === 0) return out;
  const wanted = contentInstanceIds === "all" ? null : new Set(contentInstanceIds);
  const needles =
    wanted === null || wanted.size > NESTED_PARENT_ID_NEEDLES_MAX
      ? ["contentInstanceId"]
      : [...wanted];
  const candidates = await findContentInstancesContaining(tx, branchId, needles);
  for (const c of candidates) {
    const refs = collectNestedRefs(JSON.parse(c.valuesText) as Record<string, unknown>);
    for (const childId of new Set(refs.map((r) => r.contentInstanceId))) {
      if (childId === c.contentInstanceId || (wanted !== null && !wanted.has(childId))) continue;
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
 */
export async function loadContentInstanceReach(
  tx: Tx,
  branchId: string | null,
  contentInstanceIds: readonly string[],
): Promise<Map<string, ContentInstanceReach>> {
  const out = new Map<string, ContentInstanceReach>();
  const ids = [...new Set(contentInstanceIds)];
  if (ids.length === 0) return out;

  // Module field defaults that list an instance, for every instance at
  // once: the walk below and the module-default reach both read it.
  const moduleParents = await moduleDefaultParents(tx, branchId, null);

  // 1. Parent instances, transitively. Past a few ids one scan of every
  // nested ref answers all levels of the walk. An instance whose module's
  // field default lists the child, and which leaves that field unset,
  // renders the child too (the renderer falls back to the default), so it
  // is walked as a parent as well — `parentsOf` keeps only the stored
  // references, `shownBy` every parent the walk follows.
  const parentsOf = new Map<string, string[]>();
  const shownBy = new Map<string, string[]>();
  const instancesByModule = new Map<string, ContentInstanceRef[]>();
  let everyParent: Map<string, string[]> | null = null;
  let frontier = ids;
  for (let depth = 0; depth < MAX_NESTING_DEPTH && frontier.length > 0; depth += 1) {
    if (everyParent === null && frontier.length > NESTED_PARENT_ID_NEEDLES_MAX) {
      everyParent = await nestedParentsInView(tx, branchId, "all");
    }
    const found = everyParent ?? (await nestedParentsInView(tx, branchId, frontier));
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
          if (!Object.hasOwn(values, m.field)) shown.add(ci.contentInstanceId);
        }
      }
      shownBy.set(id, [...shown]);
      for (const p of shown) if (!parentsOf.has(p)) next.add(p);
    }
    frontier = [...next];
  }
  const closure = [...parentsOf.keys()];
  const inClosure = new Set(closure);

  // 2. Shared lists that show any instance of the closure.
  const listParents = new Map<string, ListParent[]>();
  for (const list of await loadListEntities(tx, "list", branchId)) {
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
  const placements = await listPlacementsInView(tx, closure, branchId);
  const parentModuleIds = [
    ...new Set(closure.flatMap((id) => moduleParents.get(id) ?? []).map((m) => m.moduleId)),
  ];
  // A module default renders on a placement whose own content leaves that
  // field empty, so these are the pages it MAY render on — the right side
  // to err on for a blast radius — as the branch's page layouts place it.
  const modulePages = await findModulePagePlacements(tx, branchId, parentModuleIds);
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
    for (const a of ancestors) {
      for (const m of moduleParents.get(a) ?? []) {
        for (const page of modulePages.get(m.moduleId) ?? []) pages.set(page.pageId, page);
        for (const l of moduleLayouts.get(m.moduleId) ?? []) layouts.set(l.layoutId, l);
      }
      for (const l of listParents.get(a) ?? []) viaLists.set(l.listId, l);
    }
    out.set(id, {
      placements: placements.filter((p) => p.contentInstanceId === id),
      parentInstances: parentsOf.get(id) ?? [],
      parentModules: moduleParents.get(id) ?? [],
      parentLists: listParents.get(id) ?? [],
      pages: [...pages.values()].sort((a, b) => a.path.localeCompare(b.path)),
      chromeLayouts: [...layouts.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
      viaLists: [...viaLists.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    });
  }
  return out;
}

/**
 * Modules (as the caller sees them) whose field defaults reference an
 * instance of `wanted` (every instance when `null`), keyed by child id. The live read is prefiltered on
 * the ref key; the branch's pending module states supersede live rows.
 */
async function moduleDefaultParents(
  tx: Tx,
  branchId: string | null,
  wanted: ReadonlySet<string> | null,
): Promise<Map<string, ModuleParent[]>> {
  const visible = branchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${branchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  const live = (await tx.execute(sql`
    SELECT id::text AS id, slug, display_name, fields
      FROM modules
     WHERE deleted_at IS NULL AND ${visible} AND fields::text LIKE ${"%contentInstanceId%"}
  `)) as unknown as { id: string; slug: string; display_name: string; fields: unknown }[];
  const candidates = new Map<string, { slug: string; displayName: string; fields: unknown }>();
  for (const r of live) {
    candidates.set(r.id, { slug: r.slug, displayName: r.display_name, fields: r.fields });
  }
  if (branchId) {
    for (const [id, s] of await loadBranchedModuleStates(tx, branchId)) {
      if (s.deletedAt !== null) {
        candidates.delete(id);
        continue;
      }
      candidates.set(id, { slug: s.slug, displayName: s.displayName, fields: s.fields });
    }
  }
  const out = new Map<string, ModuleParent[]>();
  for (const [moduleId, m] of candidates) {
    if (!Array.isArray(m.fields)) continue;
    for (const f of m.fields as { name?: unknown; default?: unknown }[]) {
      if (typeof f.name !== "string" || f.default === undefined) continue;
      const children = new Set(
        collectNestedRefs({ [f.name]: f.default }).map((r) => r.contentInstanceId),
      );
      for (const child of children) {
        if (wanted !== null && !wanted.has(child)) continue;
        const parent = { moduleId, slug: m.slug, displayName: m.displayName, field: f.name };
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
async function layoutsPlacingModules(
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
       AND lm.module_id IN (${sql.join(
         moduleIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
  `)) as unknown as { module_id: string; layout_id: string; slug: string }[];
  for (const r of rows) {
    const layout = { layoutId: r.layout_id, slug: r.slug };
    out.set(r.module_id, [...(out.get(r.module_id) ?? []), layout]);
  }
  return out;
}
