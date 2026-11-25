// SPDX-License-Identifier: MPL-2.0

/**
 * #1659 — the locks that keep an upserted key of a plugin's private table
 * at one row. Every upsert (private-upsert.ts) and every Stage that lands
 * rows of an upserted table (key-merge.ts) takes them, so the two see each
 * other's committed rows instead of each adding one.
 *
 * Two transaction-scoped advisory locks per table:
 *
 * - the **table lock**, named by plugin, schema and table;
 * - the **key lock**, named by plugin, schema, table and the key's values.
 *
 * An upsert takes the table lock shared, then its key's lock: upserts of
 * different keys run side by side, upserts of one key one after the other.
 * For each upserted table a Stage lands rows of, it takes either
 *
 * - the table lock shared and the lock of every key it lands, when it lands
 *   at most {@link STAGE_KEY_LOCKS_PER_TABLE} keys of the table: an upsert
 *   of any other key does not wait for the Stage; or
 * - the table lock alone, exclusive, when it lands more: every upsert of
 *   the table waits until the Stage commits.
 *
 * Why the bound: every advisory lock takes a slot of the server's shared
 * lock table (`max_locks_per_transaction` × backends; a 25-connection
 * instance ran out between 5,000 and 7,000), and a Stage holds its locks
 * until it commits. One lock per key would let the Stage of a site-wide
 * translation run fail with "out of shared memory", and while it ran,
 * every other session that needed a lock could fail the same way. With the
 * bound a Stage holds at most `STAGE_KEY_LOCKS_PER_TABLE + 1` per table.
 *
 * Every transaction takes its table locks before its key locks, each group
 * in one order (by name), so no two transactions wait on each other in a
 * cycle. Each storage operation and each merge runs in a transaction of its
 * own, so no transaction holds the locks of two upserts.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** The `hashtextextended` seed of every upsert lock name. */
const UPSERT_LOCK_SEED = 1659;

/** Keys of one table a Stage locks one by one; above that it locks the table. */
export const STAGE_KEY_LOCKS_PER_TABLE = 32;

/** A key value as an upsert normalises it and `to_jsonb` stores it. */
export type UpsertKeyValue = string | number | boolean;

/** A plugin's private table. */
export interface UpsertTableRef {
  readonly pluginId: string;
  readonly schema: string;
  readonly table: string;
}

/** One advisory lock, by name and mode. */
export interface UpsertLock {
  readonly name: string;
  readonly mode: "shared" | "exclusive";
}

/** One key a Stage lands: its table and its values. */
export interface StagedKey {
  readonly table: UpsertTableRef;
  readonly key: Readonly<Record<string, UpsertKeyValue>>;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function tableLockName(t: UpsertTableRef): string {
  return JSON.stringify([t.pluginId, t.schema, t.table]);
}

/**
 * The key lock's name. `key` holds the values in their column's spelling
 * (an upsert normalises them; a stored row's JSON already has it: a
 * lowercase uuid, a number), so a write and the Stage name one lock for one
 * key, whatever order its columns come in.
 */
function keyLockName(t: UpsertTableRef, key: Readonly<Record<string, UpsertKeyValue>>): string {
  const pairs = Object.entries(key).sort(([a], [b]) => byName(a, b));
  return JSON.stringify([t.pluginId, t.schema, t.table, pairs]);
}

async function take(tx: TransactionRunner, lock: UpsertLock): Promise<void> {
  const fn = sql.raw(
    lock.mode === "shared" ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock",
  );
  await tx.execute(sql`SELECT ${fn}(hashtextextended(${lock.name}, ${UPSERT_LOCK_SEED}))`);
}

/** An upsert's locks for the rest of its transaction (see the header). */
export async function lockUpsertKey(
  tx: TransactionRunner,
  table: UpsertTableRef,
  key: Readonly<Record<string, UpsertKeyValue>>,
): Promise<void> {
  // Two statements, so the table lock is held before the key lock is asked for.
  await take(tx, { name: tableLockName(table), mode: "shared" });
  await take(tx, { name: keyLockName(table, key), mode: "exclusive" });
}

/**
 * The locks a Stage takes for the keys it lands, in the order it takes
 * them: every table lock (by name), then every key lock (by name).
 */
export function planStageLocks(keys: readonly StagedKey[]): UpsertLock[] {
  const keysByTable = new Map<string, Set<string>>();
  for (const k of keys) {
    const table = tableLockName(k.table);
    const names = keysByTable.get(table) ?? new Set<string>();
    names.add(keyLockName(k.table, k.key));
    keysByTable.set(table, names);
  }
  const tables = [...keysByTable.keys()].sort(byName);
  const tableLocks: UpsertLock[] = [];
  const keyNames: string[] = [];
  for (const table of tables) {
    const names = keysByTable.get(table) ?? new Set<string>();
    if (names.size > STAGE_KEY_LOCKS_PER_TABLE) {
      tableLocks.push({ name: table, mode: "exclusive" });
    } else {
      tableLocks.push({ name: table, mode: "shared" });
      keyNames.push(...names);
    }
  }
  return [
    ...tableLocks,
    ...keyNames.sort(byName).map((name): UpsertLock => ({ name, mode: "exclusive" })),
  ];
}

/** Take a Stage's locks for `keys` for the rest of its transaction. */
export async function lockStagedKeys(
  tx: TransactionRunner,
  keys: readonly StagedKey[],
): Promise<void> {
  for (const lock of planStageLocks(keys)) await take(tx, lock);
}
