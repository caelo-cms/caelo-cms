// SPDX-License-Identifier: MPL-2.0

/**
 * #1659 — one row per upserted key of a plugin's private table: the lock,
 * the identity rule, and the Stage's fold.
 *
 * Every write that decides which row is a key's row goes through the two
 * pieces here, so the upsert within a line (private-upsert.ts) and the
 * Stage across lines agree:
 *
 * - **The key locks** (upsert-key-locks.ts): transaction-scoped advisory
 *   locks on the table and on the key. An upsert and a Stage that touch one
 *   key run one after the other, and each sees what the other committed; a
 *   Stage that lands many keys of a table locks the table instead of each
 *   key, so it holds a bounded number of locks.
 * - **The identity rule**: of the live rows a key has, the one with the
 *   smallest id is the key's row; a write lands on it and deletes the
 *   others.
 *
 * A row a branch creates is invisible to the main line and to other
 * branches until its Stage, so two lines can each hold a row of a key (a
 * chat translates a page property while the change consumer, on main,
 * gives the key its `missing` placeholder). Each upsert records the table's
 * key (`plugin_storage_keys`, migration 0779), and the merge
 * ({@link mergePluginRows}) lands the live branch states of such a table
 * by the rule, once per key: under the key's locks, the candidates are the
 * key's live main rows the merge has no state for, plus the merge's rows of
 * the key; the state written last lands on the smallest id (the last
 * writer wins, as at every merge) and the other candidates are deleted.
 *
 * The candidate set does not depend on a merged row's branch tag or on
 * whether it is deleted, so replaying the same pending states — a Stage
 * whose build failed merges again, `deferConsume` — gives the same keeper
 * and the same result. The main lookup is the key's equality read on main,
 * which the key's declared index drives (its predicate is the main-line
 * filter). A table nothing upserts has no key recorded, and a deleted state
 * is a delete: both merge as before.
 */

import { type TransactionRunner, textArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import {
  applyPluginRowState,
  type PluginRowRef,
  type PluginRowState,
  rowToState,
  withPluginScope,
} from "./row-snapshots.js";
import {
  type UpsertKeyValue as KeyValue,
  lockStagedKeys,
  upsertKeyName,
} from "./upsert-key-locks.js";

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Record `columns` as the key of the plugin's `table`: one key per table,
 * the latest upsert's. One statement on every upsert, and it writes only
 * when the stored key differs (or none is stored): the usual call reads the
 * row and takes no lock on it. Nothing is remembered between calls, so a
 * key another process or another call recorded meanwhile is never
 * mistaken for this one.
 */
export async function recordUpsertKey(
  tx: TransactionRunner,
  pluginId: string,
  table: string,
  columns: readonly string[],
): Promise<void> {
  const key = textArray([...columns].sort());
  await tx.execute(sql`
    INSERT INTO plugin_storage_keys (plugin_id, table_name, key_columns)
    SELECT ${pluginId}::uuid, ${table}, ${key}
    WHERE NOT EXISTS (
      SELECT 1 FROM plugin_storage_keys
      WHERE plugin_id = ${pluginId}::uuid AND table_name = ${table} AND key_columns = ${key}
    )
    ON CONFLICT (plugin_id, table_name) DO UPDATE
      SET key_columns = EXCLUDED.key_columns, updated_at = now()
  `);
}

/** One plugin row a merge applies: where, the branch's latest state, and when it was written. */
export interface MergedPluginRow {
  readonly ref: PluginRowRef;
  readonly state: PluginRowState;
  /**
   * When the branch wrote `state` (its snapshot header's time), as text
   * that sorts in time order. Of several states of one upserted key in a
   * merge, the one written last lands.
   */
  readonly writtenAt: string;
}

/** A row the merge wrote on main, with the state it now holds. */
export interface WrittenPluginRow {
  readonly ref: PluginRowRef;
  readonly state: PluginRowState;
}

/** A merged row of an upserted key: the key's columns, values and name. */
interface KeyedRow extends MergedPluginRow {
  readonly columns: readonly string[];
  readonly key: Readonly<Record<string, KeyValue>>;
}

/** The merged states of one key: the one that lands, and the others it folds. */
interface KeyFold {
  readonly lands: KeyedRow;
  readonly others: readonly KeyedRow[];
}

const byRowId = (a: MergedPluginRow, b: MergedPluginRow) =>
  a.ref.rowId < b.ref.rowId ? -1 : a.ref.rowId > b.ref.rowId ? 1 : 0;

/** The state written last first; of two written at once, the smaller id. */
const latestWrittenFirst = (a: MergedPluginRow, b: MergedPluginRow) =>
  a.writtenAt > b.writtenAt ? -1 : a.writtenAt < b.writtenAt ? 1 : byRowId(a, b);

/**
 * Apply a merge's plugin rows to main (see the header). The locks of every
 * key it lands are taken for the whole merge, in one order, before any row
 * is written (upsert-key-locks.ts), so two writers over the same keys never
 * wait on each other in a cycle.
 *
 * @returns every row written on main with its state, each once, for the
 *   merge's main-line snapshots (undo after publish).
 */
export async function mergePluginRows(
  tx: TransactionRunner,
  rows: readonly MergedPluginRow[],
): Promise<WrittenPluginRow[]> {
  // A deterministic order: a replayed merge applies the same states in
  // the same order, so it ends in the same rows.
  const ordered = [...rows].sort(byRowId);
  const merging = new Set(ordered.map((r) => r.ref.rowId));
  const byKey = new Map<string, KeyedRow[]>();
  const keysOf = new Map<string, readonly string[] | null>();
  for (const r of ordered) {
    if (r.state.deletedAt !== null) continue;
    const tableKey = `${r.ref.pluginId}|${r.ref.table}`;
    if (!keysOf.has(tableKey)) {
      keysOf.set(tableKey, await withPluginScope(tx, r.ref.pluginId, () => recordedKey(tx, r.ref)));
    }
    const columns = keysOf.get(tableKey);
    const key = columns ? keyOf(columns, r.state) : null;
    if (!columns || !key) continue;
    const name = upsertKeyName(r.ref, key);
    byKey.set(name, [...(byKey.get(name) ?? []), { ...r, columns, key }]);
  }
  await lockStagedKeys(
    tx,
    [...byKey.values()].map(([k]) => ({ table: (k as KeyedRow).ref, key: (k as KeyedRow).key })),
  );
  // Each key lands once, with its state written last (the last writer
  // wins, as at every merge); its other states are folded with it.
  const folds = new Map<string, KeyFold>();
  const foldedAway = new Set<string>();
  for (const group of byKey.values()) {
    const [lands, ...others] = [...group].sort(latestWrittenFirst) as [KeyedRow, ...KeyedRow[]];
    folds.set(lands.ref.rowId, { lands, others });
    for (const o of others) foldedAway.add(o.ref.rowId);
  }

  const written: WrittenPluginRow[] = [];
  for (const r of ordered) {
    if (foldedAway.has(r.ref.rowId)) continue;
    const fold = folds.get(r.ref.rowId);
    await withPluginScope(tx, r.ref.pluginId, async () => {
      if (!fold) {
        await applyPluginRowState(tx, r.ref, r.state);
        written.push({ ref: r.ref, state: r.state });
        return;
      }
      written.push(...(await applyByKey(tx, fold, merging)));
    });
  }
  return written;
}

/** The table's recorded key columns, or null when nothing upserts it. */
async function recordedKey(tx: TransactionRunner, ref: PluginRowRef): Promise<string[] | null> {
  const rows = (await tx.execute(sql`
    SELECT array_to_string(key_columns, ',') AS key FROM plugin_storage_keys
    WHERE plugin_id = ${ref.pluginId}::uuid AND table_name = ${ref.table}
  `)) as unknown as { key: string }[];
  const columns = rows[0]?.key.split(",");
  return columns?.every((c) => IDENT_RE.test(c)) ? columns : null;
}

/** The key's values in a state, or null when one is missing (no key row then). */
function keyOf(columns: readonly string[], state: PluginRowState): Record<string, KeyValue> | null {
  const key: Record<string, KeyValue> = {};
  for (const c of columns) {
    const v = state.values[c];
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return null;
    key[c] = v;
  }
  return key;
}

/**
 * Land one key by the identity rule: the candidates are the key's live
 * main rows this merge has no state for, plus the merge's rows of the key;
 * the state written last goes onto the smallest id, and the other
 * candidates are deleted. Runs under the key's locks, in the plugin's scope.
 *
 * @param merging every row this merge has a state for: such a row lands by
 *   its own state (or is deleted by it), never as a main row of another one.
 */
async function applyByKey(
  tx: TransactionRunner,
  fold: KeyFold,
  merging: ReadonlySet<string>,
): Promise<WrittenPluginRow[]> {
  const k = fold.lands;
  for (const ident of [k.ref.schema, k.ref.table]) {
    if (!IDENT_RE.test(ident)) throw new Error(`plugin row: refusing identifier "${ident}"`);
  }
  const target = sql.raw(`"${k.ref.schema}"."${k.ref.table}"`);
  // The key's equality read, which its declared index drives; the merge's
  // own rows are left out here rather than in SQL, so a big merge does not
  // send its whole id list with every key.
  const main = (await tx.execute(sql`
    SELECT t.id::text AS id FROM ${target} t
    WHERE t."caelo_deleted_at" IS NULL AND t."caelo_chat_branch_id" IS NULL
      AND ${sql.join(
        k.columns.map((c) => sql`t.${sql.raw(`"${c}"`)} = ${k.key[c]}`),
        sql` AND `,
      )}
  `)) as unknown as { id: string }[];
  const merged = new Map([k, ...fold.others].map((r) => [r.ref.rowId, r.state]));
  const candidates = [
    ...merged.keys(),
    ...main.map((m) => m.id).filter((id) => !merging.has(id)),
  ].sort();
  const keeperId = candidates[0] as string;
  const keeper = { ...k.ref, rowId: keeperId };
  const kept: PluginRowState = { ...k.state, values: { ...k.state.values, id: keeperId } };
  await applyPluginRowState(tx, keeper, kept);
  const written: WrittenPluginRow[] = [{ ref: keeper, state: kept }];
  const deletedAt = new Date().toISOString();
  for (const id of candidates.slice(1)) {
    const ref = { ...k.ref, rowId: id };
    // A merged row keeps its own state, deleted; a main row its current one.
    const own = merged.get(id);
    const state: PluginRowState = own
      ? { ...own, deletedAt }
      : { ...(await liveState(tx, ref)), deletedAt };
    await applyPluginRowState(tx, ref, state);
    written.push({ ref, state });
  }
  return written;
}

/** A live main row's current state, as a snapshot holds it. */
async function liveState(tx: TransactionRunner, ref: PluginRowRef): Promise<PluginRowState> {
  const target = sql.raw(`"${ref.schema}"."${ref.table}"`);
  const rows = (await tx.execute(sql`
    SELECT to_jsonb(t) AS row FROM ${target} t WHERE t.id = ${ref.rowId}::uuid
  `)) as unknown as { row: Record<string, unknown> }[];
  const row = rows[0]?.row;
  if (!row) throw new Error(`plugin row: ${ref.table} ${ref.rowId} vanished under its key lock`);
  return rowToState(row);
}
