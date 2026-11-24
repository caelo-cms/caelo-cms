// SPDX-License-Identifier: MPL-2.0

/**
 * #1659 — one row per upserted key of a plugin's private table: the lock,
 * the identity rule, and the Stage's fold.
 *
 * Every write that decides which row is a key's row goes through the two
 * pieces here, so the upsert within a line (private-upsert.ts) and the
 * Stage across lines agree:
 *
 * - **The key lock** ({@link lockUpsertKey}): a transaction-scoped
 *   advisory lock named by plugin, table and key. An upsert and a Stage
 *   that touch one key run one after the other, and each sees what the
 *   other committed.
 * - **The identity rule**: of the live rows a key has, the one with the
 *   smallest id is the key's row; a write lands on it and deletes the
 *   others.
 *
 * A row a branch creates is invisible to the main line and to other
 * branches until its Stage, so two lines can each hold a row of a key (a
 * chat translates a page property while the change consumer, on main,
 * gives the key its `missing` placeholder). Each upsert records the table's
 * key (`plugin_storage_keys`, migration 0779), and the merge
 * ({@link mergePluginRows}) applies a live branch state of such a table by
 * the rule: under the key's lock, the candidates are the key's live main
 * rows plus the merged row itself; the branch's state lands on the
 * smallest id and the other candidates are deleted.
 *
 * The candidate set does not depend on the merged row's branch tag or on
 * whether it is deleted, so replaying the same pending states — a Stage
 * whose build failed merges again, `deferConsume` — gives the same keeper
 * and the same result. The main lookup is the key's equality read on main,
 * which the key's declared index drives (its predicate is the main-line
 * filter). A table nothing upserts has no key recorded, and a deleted state
 * is a delete: both merge as before.
 */

import { type TransactionRunner, textArray, uuidArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import {
  applyPluginRowState,
  type PluginRowRef,
  type PluginRowState,
  rowToState,
  withPluginScope,
} from "./row-snapshots.js";

/** Advisory lock class of an upsert key (the `hashtextextended` seed). */
const UPSERT_KEY_LOCK_SEED = 1659;

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** A key value as an upsert normalises it and `to_jsonb` stores it. */
type KeyValue = string | number | boolean;

/**
 * Take the key's lock for the rest of the transaction. `key` holds the
 * values in their column's spelling (an upsert normalises them; a stored
 * row's JSON already has it: a lowercase uuid, a number), so a write and
 * the Stage name the same lock for the same key.
 */
export async function lockUpsertKey(
  tx: TransactionRunner,
  pluginId: string,
  schema: string,
  table: string,
  key: Readonly<Record<string, KeyValue>>,
): Promise<void> {
  const name = upsertKeyLockName(pluginId, schema, table, key);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${name}, ${UPSERT_KEY_LOCK_SEED}))`,
  );
}

/** The key lock's name: plugin, table and the key, its columns in order. */
function upsertKeyLockName(
  pluginId: string,
  schema: string,
  table: string,
  key: Readonly<Record<string, KeyValue>>,
): string {
  const pairs = Object.entries(key).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([pluginId, schema, table, pairs]);
}

/**
 * Keys this process found recorded, by `<pluginId>|<table>`. Only a key
 * read back as stored is remembered: one this transaction wrote may still
 * roll back with it.
 */
const recorded = new Map<string, string>();

/**
 * Record `columns` as the key of the plugin's `table`: one key per table,
 * the latest upsert's. After the first upsert a process does nothing here.
 */
export async function recordUpsertKey(
  tx: TransactionRunner,
  pluginId: string,
  table: string,
  columns: readonly string[],
): Promise<void> {
  const memo = `${pluginId}|${table}`;
  const key = [...columns].sort();
  const text = key.join(",");
  if (recorded.get(memo) === text) return;
  const stored = (await tx.execute(sql`
    SELECT array_to_string(key_columns, ',') AS key FROM plugin_storage_keys
    WHERE plugin_id = ${pluginId}::uuid AND table_name = ${table}
  `)) as unknown as { key: string }[];
  if (stored[0]?.key === text) {
    recorded.set(memo, text);
    return;
  }
  await tx.execute(sql`
    INSERT INTO plugin_storage_keys (plugin_id, table_name, key_columns)
    VALUES (${pluginId}::uuid, ${table}, ${textArray(key)})
    ON CONFLICT (plugin_id, table_name) DO UPDATE
      SET key_columns = EXCLUDED.key_columns, updated_at = now()
      WHERE plugin_storage_keys.key_columns IS DISTINCT FROM EXCLUDED.key_columns
  `);
}

/** One plugin row a merge applies: where, and the branch's latest state. */
export interface MergedPluginRow {
  readonly ref: PluginRowRef;
  readonly state: PluginRowState;
}

/** A merged row of an upserted key: the key's values and its lock. */
interface KeyedRow extends MergedPluginRow {
  readonly columns: readonly string[];
  readonly key: Readonly<Record<string, KeyValue>>;
  readonly lockName: string;
}

/**
 * Apply a merge's plugin rows to main (see the header). The key locks are
 * taken in one order for the whole merge, before any row is written, so
 * two writers over the same keys never wait on each other in a cycle.
 *
 * @returns every row written on main with its state, for the merge's
 *   main-line snapshots (undo after publish).
 */
export async function mergePluginRows(
  tx: TransactionRunner,
  rows: readonly MergedPluginRow[],
): Promise<MergedPluginRow[]> {
  // A deterministic order: a replayed merge applies the same states in
  // the same order, so it ends in the same rows.
  const ordered = [...rows].sort((a, b) =>
    a.ref.rowId < b.ref.rowId ? -1 : a.ref.rowId > b.ref.rowId ? 1 : 0,
  );
  const dropped = new Set(
    ordered.filter((r) => r.state.deletedAt !== null).map((r) => r.ref.rowId),
  );
  const keyed = new Map<string, KeyedRow>();
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
    keyed.set(r.ref.rowId, {
      ...r,
      columns,
      key,
      lockName: upsertKeyLockName(r.ref.pluginId, r.ref.schema, r.ref.table, key),
    });
  }
  const locks = [...new Map([...keyed.values()].map((k) => [k.lockName, k])).values()].sort(
    (a, b) => (a.lockName < b.lockName ? -1 : a.lockName > b.lockName ? 1 : 0),
  );
  for (const k of locks) {
    await lockUpsertKey(tx, k.ref.pluginId, k.ref.schema, k.ref.table, k.key);
  }

  const written: MergedPluginRow[] = [];
  for (const r of ordered) {
    const k = keyed.get(r.ref.rowId);
    await withPluginScope(tx, r.ref.pluginId, async () => {
      if (!k) {
        await applyPluginRowState(tx, r.ref, r.state);
        written.push(r);
        return;
      }
      written.push(...(await applyByKey(tx, k, dropped)));
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
 * Land one merged state of an upserted key by the identity rule: the
 * candidates are the key's live main rows (not deleted by this merge) and
 * the merged row; the state goes onto the smallest id, the other
 * candidates are deleted. Runs under the key's lock, in the plugin's scope.
 */
async function applyByKey(
  tx: TransactionRunner,
  k: KeyedRow,
  dropped: ReadonlySet<string>,
): Promise<MergedPluginRow[]> {
  for (const ident of [k.ref.schema, k.ref.table]) {
    if (!IDENT_RE.test(ident)) throw new Error(`plugin row: refusing identifier "${ident}"`);
  }
  const target = sql.raw(`"${k.ref.schema}"."${k.ref.table}"`);
  const main = (await tx.execute(sql`
    SELECT t.id::text AS id FROM ${target} t
    WHERE t."caelo_deleted_at" IS NULL AND t."caelo_chat_branch_id" IS NULL
      AND ${sql.join(
        k.columns.map((c) => sql`t.${sql.raw(`"${c}"`)} = ${k.key[c]}`),
        sql` AND `,
      )}
      AND t.id <> ALL(${uuidArray([k.ref.rowId, ...dropped])})
  `)) as unknown as { id: string }[];
  const candidates = [k.ref.rowId, ...main.map((m) => m.id)].sort();
  const keeperId = candidates[0] as string;
  const keeper = { ...k.ref, rowId: keeperId };
  const kept: PluginRowState = { ...k.state, values: { ...k.state.values, id: keeperId } };
  await applyPluginRowState(tx, keeper, kept);
  const written: MergedPluginRow[] = [{ ref: keeper, state: kept }];
  const deletedAt = new Date().toISOString();
  for (const id of candidates.slice(1)) {
    const ref = { ...k.ref, rowId: id };
    // The merged row keeps its own state, deleted; a main row its current one.
    const state: PluginRowState =
      id === k.ref.rowId ? { ...k.state, deletedAt } : { ...(await liveState(tx, ref)), deletedAt };
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
