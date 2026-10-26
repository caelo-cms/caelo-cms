// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — reverting a link migration run.
 *
 * Why not `snapshots.revert_site`: snapshots record the state AFTER a
 * write, and content that predates snapshots has no earlier state to
 * return to (revert_site also restores neither field defaults nor
 * content values). The run therefore records the before/after of every
 * part it changed, and the revert restores exactly those parts — under
 * its own snapshot (`links.revert_migration`), on main and per branch
 * like the migration itself.
 *
 * Only a part still holding what the migration wrote is restored. A part
 * edited since is a CONFLICT: restoring it would throw that edit away, so
 * the revert refuses and names every conflict (CLAUDE.md §2) unless the
 * caller explicitly asks to restore the rest and leave the edited parts.
 */

import {
  loadBranchRowStates,
  type PluginRowRef,
  type PluginRowState,
  readMainPluginRow,
  writeMainPluginColumn,
} from "@caelo-cms/plugin-host";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { ContentInstanceState, ModuleState } from "../snapshots/state.js";
import {
  type LinkMigrationChange,
  ScopeBatch,
  writeMainInstance,
  writeMainLayout,
  writeMainModule,
} from "./migrate.js";
import { stableJson } from "./migrate-convert.js";
import { loadBranchStates, loadPluginRowTasks } from "./migrate-load.js";

/** A changed part that was edited after the migration. */
export interface RevertConflict {
  readonly entityKind: LinkMigrationChange["entityKind"];
  readonly entityId: string;
  readonly branchId: string | null;
  readonly reason: string;
}

/** What a revert did. */
export interface RevertOutcome {
  readonly restored: number;
  readonly conflicts: RevertConflict[];
  readonly siteSnapshotId: string | null;
}

type Plan = { readonly change: LinkMigrationChange; readonly apply: () => Promise<void> };

const EDITED = "edited after the migration — restoring it would discard that edit";
const GONE = "no longer pending on that chat (staged or undone since)";

/**
 * Entity kinds a revert can restore. A run recorded before epic #1107 may
 * name a kind whose table migration 0354 dropped; that part has nothing
 * left to restore and is reported as a conflict instead of failing.
 */
const RESTORABLE_KINDS: ReadonlySet<string> = new Set([
  "module",
  "contentInstance",
  "layout",
  "pluginRow",
]);
const REMOVED = "this kind of content no longer exists (removed by migration 0354)";

/**
 * Restore the `before` of every change whose part still holds its
 * `after`.
 *
 * @param opts.skipConflicts false (default): any conflict refuses the
 *   whole revert and nothing is written.
 */
export async function revertLinkMigration(
  tx: TransactionRunner,
  changes: readonly LinkMigrationChange[],
  opts: { readonly actorId: string; readonly description: string; readonly skipConflicts: boolean },
): Promise<RevertOutcome> {
  const conflicts: RevertConflict[] = [];
  const plans: Plan[] = [];
  const batches = new Map<string | null, ScopeBatch>();
  const batchFor = (b: string | null): ScopeBatch => {
    const existing = batches.get(b);
    if (existing) return existing;
    const created = new ScopeBatch();
    batches.set(b, created);
    return created;
  };
  const conflict = (ch: LinkMigrationChange, reason: string): void => {
    conflicts.push({
      entityKind: ch.entityKind,
      entityId: ch.entityId,
      branchId: ch.branchId,
      reason,
    });
  };
  // Branch plugin rows: several columns of one row fold into one state.
  const branchRows = new Map<
    string,
    {
      ref: PluginRowRef;
      branchId: string;
      state: PluginRowState;
      task: string | null;
      touched: boolean;
    }
  >();

  for (const ch of [...changes].reverse()) {
    if (!RESTORABLE_KINDS.has(ch.entityKind)) {
      conflict(ch, REMOVED);
      continue;
    }
    if (ch.branchId === null) {
      const plan = await planMain(tx, ch, batchFor(null));
      if (typeof plan === "string") conflict(ch, plan);
      else plans.push(plan);
      continue;
    }
    const b = ch.branchId;
    if (ch.entityKind === "pluginRow") {
      const ref: PluginRowRef = {
        pluginId: ch.pluginId,
        schema: ch.schema,
        table: ch.table,
        rowId: ch.entityId,
      };
      const key = `${b}|${ch.pluginId}|${ch.table}|${ch.entityId}`;
      let entry = branchRows.get(key);
      if (!entry) {
        const states = await loadBranchRowStates(tx, {
          pluginId: ch.pluginId,
          table: ch.table,
          chatBranchId: b,
          rowIds: [ch.entityId],
        });
        const state = states.get(ch.entityId);
        if (!state) {
          conflict(ch, GONE);
          continue;
        }
        const tasks = await loadPluginRowTasks(tx, b, ch.pluginId, ch.table);
        entry = { ref, branchId: b, state, task: tasks.get(ch.entityId) ?? null, touched: false };
        branchRows.set(key, entry);
      }
      if (stableJson(entry.state.values[ch.column] ?? null) !== stableJson(ch.after.value)) {
        conflict(ch, EDITED);
        continue;
      }
      entry.state = {
        ...entry.state,
        values: { ...entry.state.values, [ch.column]: ch.before.value },
      };
      entry.touched = true;
      continue;
    }
    const plan = await planBranch(tx, ch, b, batchFor(b));
    if (typeof plan === "string") conflict(ch, plan);
    else plans.push(plan);
  }

  if (conflicts.length > 0 && !opts.skipConflicts) {
    return { restored: 0, conflicts, siteSnapshotId: null };
  }
  for (const p of plans) await p.apply();
  const touchedRows = [...branchRows.values()].filter((e) => e.touched);
  for (const e of touchedRows) batchFor(e.branchId).addPluginRow(e.task, e.ref, e.state);
  let siteSnapshotId: string | null = null;
  for (const [b, batch] of batches) {
    if (batch.empty) continue;
    const id = await batch.emit(tx, opts, b, "links.revert_migration");
    if (b === null) siteSnapshotId = id;
  }
  return { restored: plans.length + touchedRows.length, conflicts, siteSnapshotId };
}

/** Check one main-line change; a plan, or the conflict reason. */
async function planMain(
  tx: TransactionRunner,
  ch: LinkMigrationChange,
  batch: ScopeBatch,
): Promise<Plan | string> {
  switch (ch.entityKind) {
    case "module": {
      const rows = (await tx.execute(sql`
        SELECT html, fields FROM modules WHERE id = ${ch.entityId}::uuid AND deleted_at IS NULL
      `)) as unknown as { html: string; fields: unknown }[];
      const r = rows[0];
      if (!r) return "deleted since the migration";
      const fields = typeof r.fields === "string" ? JSON.parse(r.fields) : r.fields;
      if (stableJson({ html: r.html, fields }) !== stableJson(ch.after)) return EDITED;
      return {
        change: ch,
        apply: async () => {
          batch.addEntity(
            null,
            await writeMainModule(tx, ch.entityId, r.html, ch.before.html, ch.before.fields),
          );
        },
      };
    }
    case "contentInstance": {
      const rows = (await tx.execute(sql`
        SELECT "values" FROM content_instances WHERE id = ${ch.entityId}::uuid AND deleted_at IS NULL
      `)) as unknown as { values: unknown }[];
      const r = rows[0];
      if (!r) return "deleted since the migration";
      const values = typeof r.values === "string" ? JSON.parse(r.values) : r.values;
      if (stableJson(values) !== stableJson(ch.after.values)) return EDITED;
      return {
        change: ch,
        apply: async () => {
          batch.addEntity(null, await writeMainInstance(tx, ch.entityId, ch.before.values));
        },
      };
    }
    case "layout": {
      const rows = (await tx.execute(sql`
        SELECT html FROM layouts WHERE id = ${ch.entityId}::uuid AND deleted_at IS NULL
      `)) as unknown as { html: string }[];
      const r = rows[0];
      if (!r) return "deleted since the migration";
      if (r.html !== ch.after.html) return EDITED;
      return {
        change: ch,
        apply: async () => {
          await writeMainLayout(tx, ch.entityId, ch.before.html);
          batch.touchedWithoutEntity = true;
        },
      };
    }
    case "pluginRow": {
      const ref: PluginRowRef = {
        pluginId: ch.pluginId,
        schema: ch.schema,
        table: ch.table,
        rowId: ch.entityId,
      };
      const row = await readMainPluginRow(tx, ref);
      if (!row) return "deleted since the migration";
      if (stableJson(row.values[ch.column] ?? null) !== stableJson(ch.after.value)) return EDITED;
      return {
        change: ch,
        apply: async () => {
          batch.addPluginRow(
            null,
            ref,
            await writeMainPluginColumn(tx, ref, ch.column, ch.before.value),
          );
        },
      };
    }
  }
}

/** Check one branch change (core entities); a plan, or the conflict reason. */
async function planBranch(
  tx: TransactionRunner,
  ch: Exclude<LinkMigrationChange, { entityKind: "pluginRow" }>,
  branchId: string,
  batch: ScopeBatch,
): Promise<Plan | string> {
  switch (ch.entityKind) {
    case "module": {
      const s = (await loadBranchStates(tx, "module", branchId, [ch.entityId]))[0];
      if (!s) return GONE;
      if (stableJson({ html: s.state.html, fields: s.state.fields }) !== stableJson(ch.after))
        return EDITED;
      const state: ModuleState = { ...s.state, html: ch.before.html, fields: ch.before.fields };
      return {
        change: ch,
        apply: async () =>
          batch.addEntity(s.chatTaskId, { kind: "module", entityId: ch.entityId, state }),
      };
    }
    case "contentInstance": {
      const s = (await loadBranchStates(tx, "contentInstance", branchId, [ch.entityId]))[0];
      if (!s) return GONE;
      if (stableJson(s.state.values) !== stableJson(ch.after.values)) return EDITED;
      const state: ContentInstanceState = { ...s.state, values: ch.before.values };
      return {
        change: ch,
        apply: async () =>
          batch.addEntity(s.chatTaskId, { kind: "contentInstance", entityId: ch.entityId, state }),
      };
    }
    case "layout":
      // Layouts are main-only; a branch change of one is corrupt run data.
      throw new Error(
        `link migration revert: layout ${ch.entityId} recorded on branch ${branchId}`,
      );
  }
}
