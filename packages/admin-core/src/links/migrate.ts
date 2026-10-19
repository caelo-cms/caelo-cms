// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — the one-time migration of literal internal
 * links into references, the engine behind `links.migrate_to_references`
 * and an import's link finalisation (`imports.resolve_links`).
 *
 * Surfaces, each converted with the shared canonicaliser in REPORT mode
 * (`migrate-convert.ts`): module HTML, module field defaults (layout
 * chrome content lives there), content-instance values (by the module's
 * declared field kinds, as the write path reads them), structured-set
 * items, and plugin storage the plugins name through their
 * `linkLocationsOperation` hook. Templates' and layouts' own HTML is
 * page structure, not a link surface: references resolve only inside
 * modules and sets (rollout B), so it is not touched.
 *
 * Scopes: main-line rows are converted in place under ONE site snapshot
 * (plugin rows ride the same header). Every chat branch with pending
 * work is converted against ITS view of the site (its own new and
 * renamed pages) by appending one pending snapshot per entity, owned by
 * the chat task that owns the state it replaces — otherwise staging the
 * chat after the migration would write literal links back into main.
 *
 * Never guessed: a link that matches no page / asset is left literal and
 * listed in the result (`unresolved`) with where it was found. A re-run
 * is a no-op for everything already converted (a reference is left as
 * it is) and re-reports what is still unresolved.
 */

import {
  collectPluginLinkLocations,
  insertPluginRowSnapshot,
  loadBranchRowStates,
  MAIN_RENDER,
  type PluginLinkLocationSet,
  type PluginRowRef,
  type PluginRowState,
  readMainPluginRow,
  writeMainPluginColumn,
} from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import type { CanonicaliseField, LinkCanonicaliseIssue } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { applyMediaUsageDelta } from "../ops/content/media-usage.js";
import {
  emitSnapshot,
  loadContentInstanceState,
  loadModuleState,
  type SnapshotEntity,
} from "../snapshots/index.js";
import type { ContentInstanceState, ModuleState, StructuredSetState } from "../snapshots/state.js";
import { jsonbParam } from "../sql-helpers.js";
import { loadLinkTargetLookup } from "./canonicalise.js";
import {
  type ConvertContext,
  convertContentValues,
  convertFieldDefaults,
  convertModuleHtml,
  convertPluginValue,
  convertSetItems,
  declaredFields,
  type LinkSurface,
  type PartOutcome,
} from "./migrate-convert.js";
import {
  loadAllModuleFields,
  loadBranchStates,
  loadMainInstances,
  loadMainModules,
  loadMainSets,
  loadPendingBranches,
  loadPluginRowTasks,
} from "./migrate-load.js";

/** One link the migration left literal. */
export interface UnresolvedLink {
  readonly surface: LinkSurface;
  readonly entityKind: "module" | "contentInstance" | "structuredSet" | "pluginRow";
  readonly entityId: string;
  /** Null on main; the chat branch whose pending work holds it otherwise. */
  readonly branchId: string | null;
  /** Operator-facing: which module / content / menu / plugin row. */
  readonly label: string;
  readonly where: string;
  readonly value: string;
  readonly kind: LinkCanonicaliseIssue["kind"];
}

/** One changed entity part: the revert's input. */
export type LinkMigrationChange =
  | {
      readonly entityKind: "module";
      readonly entityId: string;
      readonly branchId: string | null;
      readonly before: { readonly html: string; readonly fields: unknown[] };
      readonly after: { readonly html: string; readonly fields: unknown[] };
    }
  | {
      readonly entityKind: "contentInstance";
      readonly entityId: string;
      readonly branchId: string | null;
      readonly before: { readonly values: Record<string, unknown> };
      readonly after: { readonly values: Record<string, unknown> };
    }
  | {
      readonly entityKind: "structuredSet";
      readonly entityId: string;
      readonly branchId: string | null;
      readonly before: { readonly items: unknown[] };
      readonly after: { readonly items: unknown[] };
    }
  | {
      readonly entityKind: "pluginRow";
      readonly entityId: string;
      readonly branchId: string | null;
      readonly pluginId: string;
      readonly schema: string;
      readonly table: string;
      readonly column: string;
      readonly before: { readonly value: unknown };
      readonly after: { readonly value: unknown };
    };

/** What to migrate. */
export interface LinkMigrationScope {
  /** false = dry run: compute everything, write nothing. */
  readonly apply: boolean;
  readonly actorId: string;
  /** Snapshot description. */
  readonly description: string;
  /** Convert main-line rows. */
  readonly includeMain: boolean;
  /** Which chat branches' pending work to convert. */
  readonly branches: "all" | readonly string[];
  /** Hosts whose absolute URLs mean this site (an import's source host). */
  readonly extraOwnHosts?: readonly string[];
  /** Only these literals (an import's recorded links); see LinkCanonicaliseRun.only. */
  readonly only?: ReadonlySet<string>;
}

/** What a migration did (or, dry, would do). */
export interface LinkMigrationResult {
  /** Links converted per surface. */
  readonly counts: Record<string, number>;
  readonly entitiesChanged: number;
  readonly unresolved: UnresolvedLink[];
  readonly changes: LinkMigrationChange[];
  /** The main-line snapshot, when something on main changed. */
  readonly siteSnapshotId: string | null;
}

/** Accumulates one scope's (main or one branch) snapshot entities. */
export class ScopeBatch {
  readonly entities = new Map<string | null, SnapshotEntity[]>();
  readonly pluginRows = new Map<string | null, { ref: PluginRowRef; state: PluginRowState }[]>();

  addEntity(task: string | null, e: SnapshotEntity): void {
    const list = this.entities.get(task) ?? [];
    list.push(e);
    this.entities.set(task, list);
  }

  addPluginRow(task: string | null, ref: PluginRowRef, state: PluginRowState): void {
    const list = this.pluginRows.get(task) ?? [];
    list.push({ ref, state });
    this.pluginRows.set(task, list);
  }

  get empty(): boolean {
    return this.entities.size === 0 && this.pluginRows.size === 0;
  }

  /** One snapshot header per owning chat task (main: exactly one). */
  async emit(
    tx: TransactionRunner,
    scope: { readonly actorId: string; readonly description: string },
    branchId: string | null,
    opKind: "links.migrate_to_references" | "links.revert_migration",
  ): Promise<string | null> {
    let first: string | null = null;
    const tasks = new Set([...this.entities.keys(), ...this.pluginRows.keys()]);
    for (const task of tasks) {
      const { siteSnapshotId } = await emitSnapshot(tx, {
        actorId: scope.actorId,
        opKind,
        description: scope.description,
        chatTaskId: task,
        chatBranchId: branchId,
        entities: this.entities.get(task) ?? [],
      });
      for (const p of this.pluginRows.get(task) ?? []) {
        await insertPluginRowSnapshot(tx, siteSnapshotId, p.ref, p.state);
      }
      first ??= siteSnapshotId;
    }
    return first;
  }
}

class Collector {
  readonly counts: Record<string, number> = {};
  readonly unresolved: UnresolvedLink[] = [];
  readonly changes: LinkMigrationChange[] = [];
  entitiesChanged = 0;

  record<T>(
    out: PartOutcome<T>,
    surface: LinkSurface,
    entity: Omit<UnresolvedLink, "surface" | "where" | "value" | "kind">,
  ): void {
    if (out.converted > 0) this.counts[surface] = (this.counts[surface] ?? 0) + out.converted;
    for (const i of out.issues) {
      this.unresolved.push({ ...entity, surface, where: i.where, value: i.value, kind: i.kind });
    }
  }
}

/** The task that owns a branch state (null on main). */
type Owned<S> = { readonly state: S; readonly task: string | null };

/**
 * Run the migration in `tx`. Plugin hooks are asked first, before any
 * write, so their reads (on their own connections) never wait on this
 * transaction's row locks.
 */
export async function migrateLinksToReferences(
  tx: TransactionRunner,
  scope: LinkMigrationScope,
): Promise<LinkMigrationResult> {
  const branches = scope.branches === "all" ? await loadPendingBranches(tx) : [...scope.branches];
  const pluginMain = scope.includeMain ? await collectPluginLinkLocations(MAIN_RENDER) : [];
  const pluginByBranch = new Map<string, PluginLinkLocationSet[]>();
  for (const b of branches) {
    pluginByBranch.set(b, await collectPluginLinkLocations({ chatBranchId: b }));
  }

  const c = new Collector();
  const moduleFields = await loadAllModuleFields(tx);
  let siteSnapshotId: string | null = null;

  if (scope.includeMain) {
    const lookup = await loadLinkTargetLookup(tx, null, scope.extraOwnHosts ?? []);
    const cx: ConvertContext = { lookup, ...(scope.only ? { only: scope.only } : {}) };
    const batch = new ScopeBatch();
    await migrateMainModules(tx, scope, cx, c, batch);
    await migrateMainInstances(tx, scope, cx, c, batch, moduleFields);
    await migrateMainSets(tx, scope, cx, c, batch);
    await migrateMainPluginRows(tx, scope, cx, c, batch, pluginMain, moduleFields);
    if (scope.apply && !batch.empty) {
      siteSnapshotId = await batch.emit(tx, scope, null, "links.migrate_to_references");
    }
  }

  for (const b of branches) {
    const lookup = await loadLinkTargetLookup(tx, b, scope.extraOwnHosts ?? []);
    const cx: ConvertContext = { lookup, ...(scope.only ? { only: scope.only } : {}) };
    const batch = new ScopeBatch();
    await migrateBranch(tx, b, cx, c, batch, pluginByBranch.get(b) ?? [], moduleFields);
    if (scope.apply && !batch.empty) {
      await batch.emit(tx, scope, b, "links.migrate_to_references");
    }
  }

  return {
    counts: c.counts,
    entitiesChanged: c.entitiesChanged,
    unresolved: c.unresolved,
    changes: c.changes,
    siteSnapshotId,
  };
}

async function migrateMainModules(
  tx: TransactionRunner,
  scope: LinkMigrationScope,
  cx: ConvertContext,
  c: Collector,
  batch: ScopeBatch,
): Promise<void> {
  for (const m of await loadMainModules(tx)) {
    const html = convertModuleHtml(m.html, cx);
    const fields = convertFieldDefaults(m.fields, cx);
    const entity = {
      entityKind: "module" as const,
      entityId: m.id,
      branchId: null,
      label: `module "${m.displayName}"`,
    };
    c.record(html, "module_html", entity);
    c.record(fields, "module_field_defaults", entity);
    if (!html.changed && !fields.changed) continue;
    c.entitiesChanged += 1;
    c.changes.push({
      entityKind: "module",
      entityId: m.id,
      branchId: null,
      before: { html: m.html, fields: m.fields },
      after: { html: html.next, fields: fields.next },
    });
    if (!scope.apply) continue;
    batch.addEntity(null, await writeMainModule(tx, m.id, m.html, html.next, fields.next));
  }
}

/** Write a main-line module's HTML + fields; returns its snapshot entity. */
export async function writeMainModule(
  tx: TransactionRunner,
  id: string,
  prevHtml: string,
  html: string,
  fields: unknown[],
): Promise<SnapshotEntity> {
  await tx.execute(sql`
    UPDATE modules SET html = ${html}, fields = ${jsonbParam(JSON.stringify(fields))}, updated_at = now()
     WHERE id = ${id}::uuid
  `);
  // Usage counting reads both link forms; keep the delta honest anyway.
  await applyMediaUsageDelta(tx, prevHtml, html);
  const state = await loadModuleState(tx, id);
  if (!state) throw new Error(`link migration: module ${id} vanished mid-write`);
  return { kind: "module", entityId: id, state };
}

async function migrateMainInstances(
  tx: TransactionRunner,
  scope: LinkMigrationScope,
  cx: ConvertContext,
  c: Collector,
  batch: ScopeBatch,
  moduleFields: Map<string, { name: string; fields: unknown[] }>,
): Promise<void> {
  for (const ci of await loadMainInstances(tx)) {
    const mod = moduleFields.get(ci.moduleId);
    const out = convertContentValues(declaredFields(mod?.fields), ci.values, cx);
    const label = `content "${ci.label ?? mod?.name ?? ci.id}"${mod && ci.label ? ` (${mod.name})` : ""}`;
    c.record(out, "content_values", {
      entityKind: "contentInstance",
      entityId: ci.id,
      branchId: null,
      label,
    });
    if (!out.changed) continue;
    c.entitiesChanged += 1;
    c.changes.push({
      entityKind: "contentInstance",
      entityId: ci.id,
      branchId: null,
      before: { values: ci.values },
      after: { values: out.next },
    });
    if (!scope.apply) continue;
    batch.addEntity(null, await writeMainInstance(tx, ci.id, out.next));
  }
}

/** Write a main-line instance's values (a real write: version bumps). */
export async function writeMainInstance(
  tx: TransactionRunner,
  id: string,
  values: Record<string, unknown>,
): Promise<SnapshotEntity> {
  await tx.execute(sql`
    UPDATE content_instances
       SET "values" = ${jsonbParam(JSON.stringify(values))}, version = version + 1, updated_at = now()
     WHERE id = ${id}::uuid
  `);
  const state = await loadContentInstanceState(tx, id);
  if (!state) throw new Error(`link migration: content instance ${id} vanished mid-write`);
  return { kind: "contentInstance", entityId: id, state };
}

async function migrateMainSets(
  tx: TransactionRunner,
  scope: LinkMigrationScope,
  cx: ConvertContext,
  c: Collector,
  batch: ScopeBatch,
): Promise<void> {
  for (const s of await loadMainSets(tx)) {
    const out = convertSetItems(s.items, cx);
    c.record(out, "structured_sets", {
      entityKind: "structuredSet",
      entityId: s.id,
      branchId: null,
      label: `${s.kind} "${s.displayName}"`,
    });
    if (!out.changed) continue;
    c.entitiesChanged += 1;
    c.changes.push({
      entityKind: "structuredSet",
      entityId: s.id,
      branchId: null,
      before: { items: s.items },
      after: { items: out.next },
    });
    if (!scope.apply) continue;
    batch.addEntity(null, await writeMainSet(tx, s, out.next));
  }
}

/** Write a main-line set's items; returns its snapshot entity. */
export async function writeMainSet(
  tx: TransactionRunner,
  s: {
    readonly id: string;
    readonly kind: string;
    readonly slug: string;
    readonly displayName: string;
  },
  items: unknown[],
): Promise<SnapshotEntity> {
  await tx.execute(sql`
    UPDATE structured_sets SET items = ${jsonbParam(JSON.stringify(items))}, updated_at = now()
     WHERE id = ${s.id}::uuid
  `);
  const state: StructuredSetState = {
    schemaVersion: 1,
    kind: s.kind,
    slug: s.slug,
    displayName: s.displayName,
    items,
    deletedAt: null,
  };
  return { kind: "structuredSet", entityId: s.id, state };
}

function fieldsFor(
  loc: { readonly fields?: readonly { name: string; kind: string }[]; readonly moduleId?: string },
  moduleFields: Map<string, { name: string; fields: unknown[] }>,
): CanonicaliseField[] | undefined {
  if (loc.fields) return [...loc.fields];
  if (loc.moduleId) return declaredFields(moduleFields.get(loc.moduleId)?.fields);
  return undefined;
}

async function migrateMainPluginRows(
  tx: TransactionRunner,
  scope: LinkMigrationScope,
  cx: ConvertContext,
  c: Collector,
  batch: ScopeBatch,
  sets: readonly PluginLinkLocationSet[],
  moduleFields: Map<string, { name: string; fields: unknown[] }>,
): Promise<void> {
  for (const set of sets) {
    for (const loc of set.locations) {
      const ref: PluginRowRef = {
        pluginId: set.pluginId,
        schema: set.schema,
        table: loc.table,
        rowId: loc.rowId,
      };
      const row = await readMainPluginRow(tx, ref);
      if (!row) continue; // branch-created or deleted: not a main-line row
      const before = row.values[loc.column] ?? null;
      const out = convertPluginValue(loc.column, before, fieldsFor(loc, moduleFields), cx);
      c.record(out, `plugin:${set.pluginSlug}`, {
        entityKind: "pluginRow",
        entityId: loc.rowId,
        branchId: null,
        label: loc.label,
      });
      if (!out.changed) continue;
      c.entitiesChanged += 1;
      c.changes.push({
        entityKind: "pluginRow",
        entityId: loc.rowId,
        branchId: null,
        pluginId: set.pluginId,
        schema: set.schema,
        table: loc.table,
        column: loc.column,
        before: { value: before },
        after: { value: out.next },
      });
      if (!scope.apply) continue;
      batch.addPluginRow(null, ref, await writeMainPluginColumn(tx, ref, loc.column, out.next));
    }
  }
}

/**
 * Convert one branch's pending states. Only entities the branch has a
 * pending state for are looked at; everything else the branch sees is
 * main's, converted in the main pass.
 */
async function migrateBranch(
  tx: TransactionRunner,
  branchId: string,
  cx: ConvertContext,
  c: Collector,
  batch: ScopeBatch,
  pluginSets: readonly PluginLinkLocationSet[],
  moduleFields: Map<string, { name: string; fields: unknown[] }>,
): Promise<void> {
  const modules = await loadBranchStates(tx, "module", branchId);
  // A chat that changed a module's fields renders its instances with them.
  const fieldsOf = new Map(moduleFields);
  for (const m of modules)
    fieldsOf.set(m.entityId, { name: m.state.displayName, fields: m.state.fields });

  for (const m of modules) {
    if (m.state.deletedAt) continue;
    const html = convertModuleHtml(m.state.html, cx);
    const fields = convertFieldDefaults(m.state.fields, cx);
    const entity = {
      entityKind: "module" as const,
      entityId: m.entityId,
      branchId,
      label: `module "${m.state.displayName}"`,
    };
    c.record(html, "module_html", entity);
    c.record(fields, "module_field_defaults", entity);
    if (!html.changed && !fields.changed) continue;
    c.entitiesChanged += 1;
    c.changes.push({
      entityKind: "module",
      entityId: m.entityId,
      branchId,
      before: { html: m.state.html, fields: m.state.fields },
      after: { html: html.next, fields: fields.next },
    });
    const state: ModuleState = { ...m.state, html: html.next, fields: fields.next };
    batch.addEntity(m.chatTaskId, { kind: "module", entityId: m.entityId, state });
  }

  for (const ci of await loadBranchStates(tx, "contentInstance", branchId)) {
    if (ci.state.deletedAt) continue;
    const mod = fieldsOf.get(ci.state.moduleId);
    const out = convertContentValues(declaredFields(mod?.fields), ci.state.values, cx);
    const name = ci.state.displayName ?? ci.state.slug ?? mod?.name ?? ci.entityId;
    c.record(out, "content_values", {
      entityKind: "contentInstance",
      entityId: ci.entityId,
      branchId,
      label: `content "${name}"`,
    });
    if (!out.changed) continue;
    c.entitiesChanged += 1;
    c.changes.push({
      entityKind: "contentInstance",
      entityId: ci.entityId,
      branchId,
      before: { values: ci.state.values },
      after: { values: out.next },
    });
    const state: ContentInstanceState = { ...ci.state, values: out.next };
    batch.addEntity(ci.chatTaskId, { kind: "contentInstance", entityId: ci.entityId, state });
  }

  for (const s of await loadBranchStates(tx, "structuredSet", branchId)) {
    if (s.state.deletedAt) continue;
    const out = convertSetItems(s.state.items, cx);
    c.record(out, "structured_sets", {
      entityKind: "structuredSet",
      entityId: s.entityId,
      branchId,
      label: `${s.state.kind} "${s.state.displayName}"`,
    });
    if (!out.changed) continue;
    c.entitiesChanged += 1;
    c.changes.push({
      entityKind: "structuredSet",
      entityId: s.entityId,
      branchId,
      before: { items: [...s.state.items] },
      after: { items: out.next },
    });
    const state: StructuredSetState = { ...s.state, items: out.next };
    batch.addEntity(s.chatTaskId, { kind: "structuredSet", entityId: s.entityId, state });
  }

  for (const set of pluginSets) {
    const byTable = new Map<string, (typeof set.locations)[number][]>();
    for (const loc of set.locations)
      byTable.set(loc.table, [...(byTable.get(loc.table) ?? []), loc]);
    for (const [table, locs] of byTable) {
      const states = await loadBranchRowStates(tx, {
        pluginId: set.pluginId,
        table,
        chatBranchId: branchId,
        rowIds: locs.map((l) => l.rowId),
      });
      if (states.size === 0) continue;
      const tasks = await loadPluginRowTasks(tx, branchId, set.pluginId, table);
      // Several columns of one row become one appended state.
      const next = new Map<string, Owned<PluginRowState>>();
      for (const loc of locs) {
        const current = next.get(loc.rowId)?.state ?? states.get(loc.rowId);
        if (!current || current.deletedAt) continue;
        const before = current.values[loc.column] ?? null;
        const out = convertPluginValue(loc.column, before, fieldsFor(loc, fieldsOf), cx);
        c.record(out, `plugin:${set.pluginSlug}`, {
          entityKind: "pluginRow",
          entityId: loc.rowId,
          branchId,
          label: loc.label,
        });
        if (!out.changed) continue;
        c.entitiesChanged += 1;
        c.changes.push({
          entityKind: "pluginRow",
          entityId: loc.rowId,
          branchId,
          pluginId: set.pluginId,
          schema: set.schema,
          table,
          column: loc.column,
          before: { value: before },
          after: { value: out.next },
        });
        next.set(loc.rowId, {
          state: { ...current, values: { ...current.values, [loc.column]: out.next } },
          task: tasks.get(loc.rowId) ?? null,
        });
      }
      for (const [rowId, owned] of next) {
        batch.addPluginRow(
          owned.task,
          { pluginId: set.pluginId, schema: set.schema, table, rowId },
          owned.state,
        );
      }
    }
  }
}
