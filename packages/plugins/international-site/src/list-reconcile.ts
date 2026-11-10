// SPDX-License-Identifier: MPL-2.0

/**
 * #1269 — the list translations' statuses, reconciled for what a batch of
 * changes names instead of for the whole site.
 *
 * The change consumer used to re-derive every list translation status of
 * the site on every batch: every page, every content instance, every page
 * variant and every stored translation, per main-line batch — the largest
 * database load left on a 50k-page site. A stored translation belongs to
 * exactly one TARGET, which its address names:
 *
 *   list/<listId>/…          → `list:<listId>`         (a shared list)
 *   instance/<ciId>/…        → `instance:<ciId>`       (an instance's local lists)
 *   source/<name>/…          → `source:<name>`         (a plugin's texts, #1323)
 *   page/<pageId>/props/…    → the page                (page_prop_translations)
 *
 * and its status depends only on that target's source. So reconciling the
 * targets a batch changed, with their stored rows, gives exactly what the
 * whole reconcile gives for them; the other targets' rows are untouched by
 * the batch and stay as they were. Value rows carry their target in a
 * column (`target`) so a target's rows are read without knowing which
 * addresses it once had — a removed entry's row is found and orphaned.
 *
 * Which targets a change names ({@link reconcileScopeOf}):
 *   - a list → that list;
 *   - a content instance → that instance;
 *   - a page, its placements or its content → the instances placed on it
 *     (a new placement can make an instance show in another language) and
 *     its language-version properties (its own, or its group's when it is
 *     the source);
 *   - a module whose fields changed → its instances (a local list field
 *     added or removed);
 *   - a page variant written → the same as its page;
 *   - plugin texts → every batch (another plugin's storage sends this
 *     plugin no changes; they are few).
 * A list type or page type changes the shape of every list or property of
 * that type, a removed variant no longer names its page, and a truncate
 * names nothing: those take the whole reconcile, which is also the rebuild.
 *
 * An instance shown in no other language keeps its rows (collectSources):
 * a removed placement names no instance, so only a removed instance, field
 * or entry orphans a row — each of which names its target.
 *
 * Garbage collection of orphaned rows waits for a production build that
 * started after the removal; it runs once per such build
 * ({@link collectLiveOrphans}), reading the orphaned rows by status.
 */

import type { ListTypeDef, PageTypeDef } from "@caelo-cms/plugin-sdk";
import type { ChromeDeps } from "./chrome-ops.js";
import type { PageVariantRow } from "./index.js";
import {
  collectSources,
  type ListSourceSnapshot,
  type ReconcileRow,
  reconcile,
  type SourceList,
  targetOfAddress,
} from "./list-translation.js";
import {
  type InstanceInfo,
  loadPluginSources,
  localListSources,
  type ModuleInfo,
  type PageInfo,
  type PagePropTranslationRow,
  pagePropSources,
  type TermTranslationRow,
  type ValueTranslationRow,
} from "./list-translation-ops.js";
import { chunked, listAll, listWhereAnyOf } from "./store-reads.js";

/** The targets one reconcile covers; `"all"` = the whole site (the rebuild). */
export type ReconcileScope =
  | "all"
  | {
      readonly lists: ReadonlySet<string>;
      readonly instances: ReadonlySet<string>;
      /** Pages whose language-version properties to check (see the header). */
      readonly pages: ReadonlySet<string>;
    };

/** Settings key: the production build whose removals were last collected. */
export const ORPHANS_COLLECTED_KEY = "list_orphans_collected_for";

/** Whether a module declares a local list field (the instances that hold list texts). */
function hasLocalListField(m: ModuleInfo): boolean {
  return m.fields.some((f) => {
    const o = f as { name?: unknown; kind?: unknown; listType?: unknown; bind?: unknown };
    return (
      o.kind === "list" &&
      typeof o.name === "string" &&
      typeof o.listType === "string" &&
      (o.bind === undefined || o.bind === "local")
    );
  });
}

/** What a reconcile compares: the source of its targets and their stored rows. */
interface ReconcileInput {
  readonly snapshot: ListSourceSnapshot;
  readonly values: readonly ValueTranslationRow[];
  readonly terms: readonly TermTranslationRow[];
  readonly props: readonly PagePropTranslationRow[];
}

/**
 * Give value rows written without a target (before #1269, or by the
 * previous release during a roll) their target. One read that is empty
 * once they are filled; one write per target.
 */
async function fillValueTargets(deps: ChromeDeps): Promise<void> {
  const rows = (await listAll(deps.q, "list_value_translations", {
    target: null,
  })) as unknown as ValueTranslationRow[];
  const byTarget = new Map<string, string[]>();
  for (const r of rows) {
    const t = targetOfAddress(r.address);
    byTarget.set(t, [...(byTarget.get(t) ?? []), r.id]);
  }
  for (const [target, ids] of byTarget) {
    for (const part of chunked(ids)) {
      await deps.q.updateMany("list_value_translations", part, { target });
    }
  }
}

/** The local-list instances of `scope`, with the pages each is placed on. */
async function loadInstances(
  deps: ChromeDeps,
  scope: ReconcileScope,
): Promise<{
  instances: InstanceInfo[];
  modules: ModuleInfo[];
  pagesOfInstance: Map<string, string[]>;
}> {
  const { cms } = deps;
  const all = scope === "all";
  if (!all && scope.instances.size === 0) {
    return { instances: [], modules: [], pagesOfInstance: new Map() };
  }
  const modules = (await cms.call<{ modules: ModuleInfo[] }>("modules.list", {})).modules;
  const listModules = new Set(modules.filter(hasLocalListField).map((m) => m.id));
  if (listModules.size === 0) return { instances: [], modules, pagesOfInstance: new Map() };
  const instances: InstanceInfo[] = [];
  const parts = all ? chunked([...listModules]) : chunked([...scope.instances]);
  for (const part of parts) {
    const r = await cms.call<{ instances: InstanceInfo[] }>(
      "content_instances.list",
      all ? { moduleIds: part } : { ids: part },
    );
    instances.push(...r.instances.filter((ci) => listModules.has(ci.moduleId)));
  }
  const pagesOfInstance = new Map<string, string[]>();
  for (const part of chunked(instances.map((ci) => ci.id))) {
    const r = await cms.call<{
      listInstances: { contentInstanceId: string; pageIds: string[] }[];
    }>("pages.list_shared_content", { listInstanceIds: part });
    for (const li of r.listInstances) pagesOfInstance.set(li.contentInstanceId, li.pageIds);
  }
  return { instances, modules, pagesOfInstance };
}

/**
 * The language versions whose properties `scope` covers, with their
 * groups' source pages: for a page of the scope that is a language
 * version, itself; for one that is its group's source, every language
 * version of the group.
 */
async function loadPropVariants(
  deps: ChromeDeps,
  scope: ReconcileScope,
): Promise<{ targets: PageVariantRow[]; sourceByGroup: Map<string, string> }> {
  const known = (v: PageVariantRow) => deps.locales.has(v.locale_code);
  let rows: PageVariantRow[];
  let named: (v: PageVariantRow) => boolean;
  if (scope === "all") {
    rows = ((await listAll(deps.q, "page_variants")) as unknown as PageVariantRow[]).filter(known);
    named = () => true;
  } else {
    if (scope.pages.size === 0) return { targets: [], sourceByGroup: new Map() };
    const own = (await listWhereAnyOf(deps.q, "page_variants", "page_id", [
      ...scope.pages,
    ])) as unknown as PageVariantRow[];
    const groups = [...new Set(own.map((v) => v.group_id))];
    rows = (
      (await listWhereAnyOf(
        deps.q,
        "page_variants",
        "group_id",
        groups,
      )) as unknown as PageVariantRow[]
    ).filter(known);
    const sourceGroups = new Set(
      own.filter((v) => v.translation_status === "source").map((v) => v.group_id),
    );
    named = (v) => scope.pages.has(v.page_id) || sourceGroups.has(v.group_id);
  }
  const sourceByGroup = new Map(
    rows.filter((v) => v.translation_status === "source").map((v) => [v.group_id, v.page_id]),
  );
  return {
    targets: rows.filter((v) => v.translation_status !== "source" && named(v)),
    sourceByGroup,
  };
}

/** Load the source of `scope`'s targets and their stored rows. */
async function loadReconcileInput(
  deps: ChromeDeps,
  scope: ReconcileScope,
): Promise<ReconcileInput> {
  const { cms, q } = deps;
  const all = scope === "all";
  const def = [...deps.locales.values()].find((l) => l.is_default) ?? null;
  const defaultCode = def?.code ?? null;
  const nonDefault = [...deps.locales.values()].filter((l) => !l.is_default).map((l) => l.code);
  const listTypes: ReadonlyMap<string, ListTypeDef> = deps.listTypes;

  // Shared lists (few per site; lists.list has no id filter).
  let lists: SourceList[] = [];
  if (all || scope.lists.size > 0) {
    const r = await cms.call<{
      lists: {
        id: string;
        slug: string;
        name: string;
        type: string;
        items?: SourceList["items"];
      }[];
    }>("lists.list", { includeItems: true });
    lists = r.lists
      .filter((l) => listTypes.has(l.type) && (all || scope.lists.has(l.id)))
      .map((l) => ({ id: l.id, slug: l.slug, name: l.name, type: l.type, items: l.items ?? [] }));
  }

  // Local lists: the instances, and the languages of the pages they are on.
  const { instances, modules, pagesOfInstance } = await loadInstances(deps, scope);
  const instancePages = [...new Set([...pagesOfInstance.values()].flat())];
  const localeByPage = new Map(
    (
      (await listWhereAnyOf(
        q,
        "page_variants",
        "page_id",
        instancePages,
      )) as unknown as PageVariantRow[]
    )
      .filter((v) => deps.locales.has(v.locale_code))
      .map((v) => [v.page_id, v.locale_code]),
  );
  const sourceInstances = localListSources({
    instances,
    modules,
    pagesOfInstance,
    localeOfPage: (pageId) => localeByPage.get(pageId) ?? defaultCode,
    defaultCode,
    nonDefault,
  });

  // Page properties of language versions.
  const { targets: propVariants, sourceByGroup } = await loadPropVariants(deps, scope);
  const propPageIds = [
    ...new Set([...propVariants.map((v) => v.page_id), ...sourceByGroup.values()]),
  ];
  const pageById = new Map<string, PageInfo>();
  for (const part of chunked(propPageIds)) {
    const r = await cms.call<{ pages: PageInfo[] }>("pages.list", { pageIds: part });
    for (const p of r.pages) pageById.set(p.id, p);
  }
  const pageTypes =
    propVariants.length === 0
      ? []
      : (await cms.call<{ pageTypes: PageTypeDef[] }>("page_types.list", {})).pageTypes;
  const pageProps = pagePropSources({
    variants: propVariants,
    sourceByGroup,
    pageById,
    pageTypes,
    nonDefault,
  });

  // Plugin texts: every reconcile (see the header).
  const pluginSources = await loadPluginSources(cms, await anyPageId(deps));

  const snapshot = collectSources({
    listTypes,
    lists,
    instances: sourceInstances,
    pageProps,
    pluginSources,
  });

  // The stored rows of exactly these targets.
  await fillValueTargets(deps);
  let values: ValueTranslationRow[];
  let terms: TermTranslationRow[];
  let props: PagePropTranslationRow[];
  if (all) {
    [values, terms, props] = (await Promise.all([
      listAll(q, "list_value_translations"),
      listAll(q, "term_translations"),
      listAll(q, "page_prop_translations"),
    ])) as unknown as [ValueTranslationRow[], TermTranslationRow[], PagePropTranslationRow[]];
  } else {
    const valueTargets = [
      ...[...scope.lists].map((id) => `list:${id}`),
      ...[...scope.instances].map((id) => `instance:${id}`),
      ...pluginSources.map((s) => `source:${s.name}`),
    ];
    [values, terms, props] = (await Promise.all([
      listWhereAnyOf(q, "list_value_translations", "target", valueTargets),
      listWhereAnyOf(q, "term_translations", "list_id", [...scope.lists]),
      // A page of the scope that is no language version any more (removed,
      // made the source) has rows to orphan too.
      listWhereAnyOf(q, "page_prop_translations", "page_id", [
        ...new Set([...scope.pages, ...propVariants.map((v) => v.page_id)]),
      ]),
    ])) as unknown as [ValueTranslationRow[], TermTranslationRow[], PagePropTranslationRow[]];
  }
  return { snapshot, values, terms, props };
}

/** Any page of the site: plugin texts are asked for "the site", by one of its pages. */
async function anyPageId(deps: ChromeDeps): Promise<string | undefined> {
  const r = await deps.cms.call<{ pages: { id: string }[] }>("pages.list", { limit: 1 });
  return r.pages[0]?.id;
}

/** A stored timestamp as an ISO string (the store may hand back a Date). */
function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The worker's half: persist the statuses the source implies for the
 * targets of `scope` (added → `missing` rows, changed → `needs_update`,
 * gone → `orphaned`, back → restored), then garbage-collect orphaned rows
 * once a production build that started after the removal succeeded.
 * Runs on the main line.
 *
 * @param lastLiveAt start of the newest succeeded production build, or null.
 * @param scope the targets to reconcile; `"all"` for the whole site.
 * @returns how many rows changed.
 */
export async function reconcileListTranslations(
  deps: ChromeDeps,
  lastLiveAt: string | null,
  scope: ReconcileScope = "all",
): Promise<{ updated: number; inserted: number; collected: number }> {
  const input = await loadReconcileInput(deps, scope);
  const locales = [...deps.locales.values()].filter((l) => !l.is_default).map((l) => l.code);
  const rows: (ReconcileRow & { table: string })[] = [
    ...input.values.map((r) => ({
      table: "list_value_translations",
      id: r.id,
      locale: r.locale_code,
      address: r.address,
      hasValue: r.value !== null,
      hash: r.source_hash,
      status: r.status,
      orphanedAt: iso(r.orphaned_at),
    })),
    ...input.terms.map((r) => ({
      table: "term_translations",
      id: r.id,
      locale: r.locale_code,
      address: `list/${r.list_id}/item/${r.item_id}/name`,
      hasValue: r.name !== null && r.slug !== null,
      hash: r.source_hash,
      status: r.status,
      orphanedAt: iso(r.orphaned_at),
    })),
    ...input.props.map((r) => ({
      table: "page_prop_translations",
      id: r.id,
      locale: r.locale_code,
      address: `page/${r.page_id}/props/${r.field}`,
      hasValue: r.value !== null,
      hash: r.source_hash,
      status: r.status,
      orphanedAt: iso(r.orphaned_at),
    })),
  ];
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const plan = reconcile(input.snapshot, locales, rows, new Date().toISOString());
  const liveAt = lastLiveAt === null ? null : Date.parse(lastLiveAt);
  let collected = 0;
  let updatedCount = 0;
  for (const u of plan.updates) {
    const row = rowById.get(u.id) as ReconcileRow & { table: string };
    // Removed AND live: the removal reached production after it happened.
    const orphanedAt = u.orphanedAt ?? row.orphanedAt;
    if (u.status === "orphaned" && isLive(liveAt, orphanedAt)) {
      await deps.q.delete(row.table, u.id);
      collected += 1;
      continue;
    }
    await deps.q.update(row.table, u.id, { status: u.status, orphaned_at: u.orphanedAt });
    updatedCount += 1;
  }
  for (const ins of plan.inserts) {
    const u = ins.unit;
    if (u.store === "value") {
      await deps.q.insert("list_value_translations", {
        locale_code: ins.locale,
        address: u.address,
        target: targetOfAddress(u.address),
        value: null,
        source_hash: null,
        status: "missing",
        orphaned_at: null,
      });
    } else if (u.store === "term" && u.term) {
      await deps.q.insert("term_translations", {
        locale_code: ins.locale,
        list_id: u.term.listId,
        item_id: u.term.itemId,
        name: null,
        slug: null,
        source_hash: null,
        status: "missing",
        orphaned_at: null,
      });
    } else if (u.store === "pageProp" && u.pageProp) {
      await deps.q.insert("page_prop_translations", {
        locale_code: ins.locale,
        page_id: u.pageProp.pageId,
        field: u.pageProp.field,
        value: null,
        source_hash: null,
        status: "missing",
        orphaned_at: null,
      });
    }
  }
  collected += await collectLiveOrphans(deps, lastLiveAt);
  return { updated: updatedCount, inserted: plan.inserts.length, collected };
}

function isLive(liveAt: number | null, orphanedAt: string | null): boolean {
  return liveAt !== null && orphanedAt !== null && Date.parse(orphanedAt) < liveAt;
}

/**
 * Delete the orphaned rows whose removal a production build has made live:
 * once per such build, not per batch — a row orphaned after the build
 * started waits for the next one.
 *
 * @returns how many rows were deleted.
 */
async function collectLiveOrphans(deps: ChromeDeps, lastLiveAt: string | null): Promise<number> {
  if (lastLiveAt === null) return 0;
  const { q } = deps;
  const mark = (
    (await q.list("settings", { key: ORPHANS_COLLECTED_KEY, limit: 1 })) as unknown as {
      id: string;
      value: { liveAt?: string } | null;
    }[]
  )[0];
  if (mark?.value?.liveAt === lastLiveAt) return 0;
  const liveAt = Date.parse(lastLiveAt);
  let collected = 0;
  for (const table of ["list_value_translations", "term_translations", "page_prop_translations"]) {
    const orphaned = (await listAll(q, table, { status: "orphaned" })) as unknown as {
      id: string;
      orphaned_at: unknown;
    }[];
    for (const r of orphaned) {
      if (!isLive(liveAt, iso(r.orphaned_at))) continue;
      await q.delete(table, r.id);
      collected += 1;
    }
  }
  const value = { liveAt: lastLiveAt };
  if (mark) await q.update("settings", mark.id, { value });
  else await q.insert("settings", { key: ORPHANS_COLLECTED_KEY, value });
  return collected;
}

/** One change as the consumer receives it (the fields the scope reads). */
export interface ListChange {
  readonly kind: string;
  readonly op: "insert" | "update" | "delete" | "truncate";
  readonly rowId: string;
  readonly parentId: string | null;
  readonly table?: string | null;
  readonly changedColumns?: readonly string[] | null;
}

/** Variant columns that move a page between groups or languages. */
const VARIANT_PLACE_COLUMNS = new Set(["page_id", "group_id", "locale_code"]);

/**
 * The targets a batch of main-line changes names (see the header), or the
 * reason it needs the whole reconcile.
 */
export async function reconcileScopeOf(
  deps: ChromeDeps,
  changes: readonly ListChange[],
): Promise<{ scope: ReconcileScope } | { whole: string }> {
  const lists = new Set<string>();
  const instances = new Set<string>();
  const pages = new Set<string>();
  const placementPages = new Set<string>();
  const fieldModules = new Set<string>();
  const variantIds = new Set<string>();
  // Status-only updates: they matter only where a page became its group's
  // source (whose old source, now a version, the group re-check covers).
  // The staleness marks this consumer writes itself change nothing here.
  const statusOnly = new Set<string>();
  const touches = (c: ListChange, column: string) =>
    c.op !== "update" || c.changedColumns == null || c.changedColumns.includes(column);
  for (const c of changes) {
    if (c.op === "truncate") return { whole: `a ${c.table ?? c.kind} truncate names no rows` };
    switch (c.kind) {
      case "list":
        lists.add(c.rowId);
        break;
      case "list_type":
      case "page_type":
        return { whole: `a ${c.kind} change reshapes every list or page of that type` };
      case "content_instance":
        instances.add(c.rowId);
        break;
      case "module":
        if (touches(c, "fields")) fieldModules.add(c.rowId);
        break;
      case "page":
        pages.add(c.rowId);
        placementPages.add(c.rowId);
        break;
      case "page_layout":
        placementPages.add(c.rowId);
        break;
      case "page_module_content":
        if (c.parentId) placementPages.add(c.parentId);
        break;
      case "own":
        if (c.table !== "page_variants") break;
        if (c.op === "delete") return { whole: "a removed page variant no longer names its page" };
        if (c.op === "insert" || c.changedColumns == null) variantIds.add(c.rowId);
        else if (c.changedColumns.some((col) => VARIANT_PLACE_COLUMNS.has(col))) {
          variantIds.add(c.rowId);
        } else if (c.changedColumns.includes("translation_status")) statusOnly.add(c.rowId);
        break;
      default:
        break;
    }
  }
  const { cms, q } = deps;
  for (const v of (await listWhereAnyOf(q, "page_variants", "id", [
    ...variantIds,
    ...statusOnly,
  ])) as unknown as PageVariantRow[]) {
    if (!variantIds.has(v.id) && v.translation_status !== "source") continue;
    pages.add(v.page_id);
    placementPages.add(v.page_id);
  }
  for (const part of chunked([...placementPages])) {
    const r = await cms.call<{ listInstances: { contentInstanceId: string }[] }>(
      "pages.list_shared_content",
      { listPageIds: part },
    );
    for (const li of r.listInstances) instances.add(li.contentInstanceId);
  }
  for (const part of chunked([...fieldModules])) {
    const r = await cms.call<{ instances: { id: string }[] }>("content_instances.list", {
      moduleIds: part,
    });
    for (const ci of r.instances) instances.add(ci.id);
  }
  return { scope: { lists, instances, pages } };
}
