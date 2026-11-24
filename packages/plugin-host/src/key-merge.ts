// SPDX-License-Identifier: MPL-2.0

/**
 * #1659 — the Stage keeps an upserted key of a plugin's private table at
 * one row.
 *
 * `ctx.adminQuery.upsert` keeps a key at one row within one line: main, or
 * one branch (private-upsert.ts). A row a branch creates is invisible to the
 * main line and to other branches until its Stage, so two lines can each
 * hold a row of one key: a chat translates a page property while the change
 * consumer, on main, gives the key its `missing` placeholder; two branches
 * each translate it. Each upsert records the table's key
 * (`plugin_storage_keys`, migration 0779), and the merge folds such a row
 * when it lands: a row the merging branch created, for a key that already
 * has a live main row, is applied onto that main row (the branch's state
 * wins, as a merge's state wins for every row) and the branch's own row is
 * dropped. The lookup is the key's equality read on the main line, which
 * the key's declared index drives (its predicate is the main-line filter).
 *
 * A row the branch only changed is the key's main row already, and a table
 * nothing upserts has no key recorded: both merge as before.
 */

import { type TransactionRunner, textArray, uuidArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { applyPluginRowState, type PluginRowRef, type PluginRowState } from "./row-snapshots.js";

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

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

/**
 * Apply a branch's state of one row at a Stage, folding a second row of an
 * upserted key into the key's main row (see the header). Must run in the
 * plugin's RLS scope (`withPluginScope`), like {@link applyPluginRowState}.
 *
 * @param droppedByMerge rows this merge deletes: never a row to land on
 *   (the branch's delete of it applies too, which would take the key's
 *   only row with it).
 * @returns every row written on main with its state, for the merge's
 *   main-line snapshots (undo after publish).
 */
export async function applyPluginRowStateOnMerge(
  tx: TransactionRunner,
  row: PluginRowRef,
  state: PluginRowState,
  chatBranchId: string,
  droppedByMerge: ReadonlySet<string>,
): Promise<{ ref: PluginRowRef; state: PluginRowState }[]> {
  const keyRowId =
    state.deletedAt === null
      ? await mainRowOfKey(tx, row, state, chatBranchId, droppedByMerge)
      : null;
  if (keyRowId === null) {
    await applyPluginRowState(tx, row, state);
    return [{ ref: row, state }];
  }
  const keeper = { ...row, rowId: keyRowId };
  const kept: PluginRowState = { ...state, values: { ...state.values, id: keyRowId } };
  await applyPluginRowState(tx, keeper, kept);
  const dropped: PluginRowState = { ...state, deletedAt: new Date().toISOString() };
  await applyPluginRowState(tx, row, dropped);
  return [
    { ref: keeper, state: kept },
    { ref: row, state: dropped },
  ];
}

/**
 * The live main row of `row`'s key when `row` is one the merging branch
 * created, else null.
 */
async function mainRowOfKey(
  tx: TransactionRunner,
  row: PluginRowRef,
  state: PluginRowState,
  chatBranchId: string,
  droppedByMerge: ReadonlySet<string>,
): Promise<string | null> {
  for (const ident of [row.schema, row.table]) {
    if (!IDENT_RE.test(ident)) throw new Error(`plugin row: refusing identifier "${ident}"`);
  }
  const keys = (await tx.execute(sql`
    SELECT array_to_string(key_columns, ',') AS key FROM plugin_storage_keys
    WHERE plugin_id = ${row.pluginId}::uuid AND table_name = ${row.table}
  `)) as unknown as { key: string }[];
  const columns = keys[0]?.key.split(",");
  if (!columns || !columns.every((c) => IDENT_RE.test(c))) return null;
  const values = columns.map((c) => state.values[c]);
  if (values.some((v) => v === null || v === undefined || typeof v === "object")) return null;
  const target = sql.raw(`"${row.schema}"."${row.table}"`);
  const created = (await tx.execute(sql`
    SELECT 1 FROM ${target}
    WHERE id = ${row.rowId}::uuid AND "caelo_chat_branch_id" = ${chatBranchId}::uuid
  `)) as unknown as unknown[];
  if (created.length === 0) return null;
  const matches = (await tx.execute(sql`
    SELECT t.id::text AS id FROM ${target} t
    WHERE t."caelo_deleted_at" IS NULL AND t."caelo_chat_branch_id" IS NULL
      AND ${sql.join(
        columns.map((c, i) => sql`t.${sql.raw(`"${c}"`)} = ${values[i]}`),
        sql` AND `,
      )}
      AND t.id <> ALL(${uuidArray([row.rowId, ...droppedByMerge])})
    ORDER BY t.id
    LIMIT 1
  `)) as unknown as { id: string }[];
  return matches[0]?.id ?? null;
}
