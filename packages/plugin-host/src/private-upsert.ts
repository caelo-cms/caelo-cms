// SPDX-License-Identifier: MPL-2.0

/**
 * #1659 — one row per key in a plugin's private storage
 * (`plugin_storage.upsert`, SDK `ctx.adminQuery.upsert`).
 *
 * A `list` followed by an `insert` lets two writers each insert a row for
 * the same key, and the private zone cannot hold a unique index (a chat's
 * change lives in a snapshot, where no index sees it,
 * docs/plugin-indexes.md):
 *
 * - two chats in the shared draft both read before either insert commits:
 *   a branch insert locks only the new row's own id;
 * - a chat's insert is invisible to the main line (international-site's
 *   change consumer inserting a `missing` placeholder) and to other
 *   branches, and each Stage carried its row to main.
 *
 * An upsert keeps the key at one row in two steps:
 *
 * 1. Within the caller's line (main, or its branch). A transaction lock on
 *    the key serialises every upsert of it; each statement after the lock
 *    sees what committed before it (READ COMMITTED), so the later upsert
 *    finds the earlier one's row. The rows of the key the caller sees (main
 *    rows plus its branch's pending states) fold into one: the first by id
 *    is updated, the others are deleted. These are ordinary writes: on a
 *    chat branch each takes the row's lock, so a change by another chat in
 *    the shared draft that this chat has not seen is the usual conflict (it
 *    names `get_plugin_draft_rows`, #1387).
 * 2. Across lines, at the Stage. The upsert records the table's key, and
 *    the merge lands a branch's state of the key under the same lock and by
 *    the same rule (key-merge.ts): the smallest id among the key's rows is
 *    the key's row, the others are deleted, the branch's state wins.
 *
 * Step 2 is why the upsert never reads other branches' rows: a lookup of
 * them could only walk every pending row of the table (no declared index
 * covers branch rows), which is the size of the draft, not of the request.
 *
 * `ifExists: "keep"` changes nothing when the caller sees a row of the key.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { loadBranchOverlay } from "./branch-overlay.js";
import { lockUpsertKey, recordUpsertKey } from "./key-merge.js";
import {
  type ListPlan,
  lockPrivateRow,
  overlayRowMatches,
  type PluginRowLocker,
  privateDelete,
  privateInsert,
  privateListSql,
  privateUpdate,
} from "./private-storage.js";

/** Rows of one key one upsert folds at most (the ceiling of one read). */
export const UPSERT_FOLD_MAX = 1000;

/** One upsert, its columns already checked against the table's declaration. */
export interface UpsertWrite {
  /**
   * 1–4 key columns and their values, normalised to the column's type (a
   * uuid in lowercase), so equal keys name one lock and match one row.
   */
  readonly key: Readonly<Record<string, string | number | boolean>>;
  /** The other columns written on insert and on update (may be empty; never `id`). */
  readonly values: Readonly<Record<string, unknown>>;
  /** A value of a declared column, bound as the column's type needs. */
  readonly bind: (column: string, value: unknown) => SQL;
  readonly ifExists: "update" | "keep";
}

interface Target {
  readonly schema: string;
  readonly table: string;
  readonly columns: Readonly<Record<string, string>>;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

const col = (name: string) => sql.raw(`"${name}"`);

/** The key as the equality filter of a read (no other filter, no order). */
export function upsertKeyPlan(key: Readonly<Record<string, unknown>>): ListPlan {
  return {
    limit: UPSERT_FOLD_MAX,
    orderBy: null,
    orderDir: "asc",
    since: null,
    before: null,
    afterId: null,
    equals: Object.entries(key),
    anyOf: [],
  };
}

/**
 * Insert or update THE row of `u.key` (see the header).
 *
 * @returns the key's row id, and whether the caller saw no row before.
 */
export async function privateUpsert(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  u: UpsertWrite,
  locker: PluginRowLocker | undefined,
  operation: string,
): Promise<Outcome<{ id: string; created: boolean }>> {
  const pluginId = ctx.pluginId;
  if (!pluginId) throw new Error("plugin storage: no plugin id on the context");
  // The same lock the Stage takes for the key (key-merge.ts).
  await lockUpsertKey(tx, pluginId, t.schema, t.table, u.key);
  await recordUpsertKey(tx, pluginId, t.table, Object.keys(u.key));

  const plan = upsertKeyPlan(u.key);
  const overlay = ctx.chatBranchId
    ? await loadBranchOverlay(tx, { pluginId, table: t.table, chatBranchId: ctx.chatBranchId })
    : new Map();
  const main = (await tx.execute(privateListSql(t, plan, [...overlay.keys()]))) as unknown as {
    row: Record<string, unknown>;
  }[];
  if (main.length >= UPSERT_FOLD_MAX) {
    return {
      ok: false,
      message: `${operation}: ${main.length} rows of "${t.table}" share the key ${JSON.stringify(u.key)}, more than one call folds — nothing was written. This is a fault in the stored rows, not in the call: report it with bug_report`,
    };
  }
  const rows = [
    ...main.map((r) => String(r.row.id)),
    ...[...overlay.entries()]
      .filter(([, s]) => s.deletedAt === null && overlayRowMatches(s.values, plan))
      .map(([id]) => String(id)),
  ].sort();

  const keeper = rows[0];
  if (keeper === undefined) {
    const columns = [...Object.keys(u.key), ...Object.keys(u.values)];
    const inserted = await privateInsert(
      tx,
      ctx,
      t,
      columns,
      columns.map((c) => u.bind(c, c in u.key ? u.key[c] : u.values[c])),
      locker,
      operation,
    );
    if (!inserted.ok) return inserted;
    return { ok: true, value: { id: inserted.value.id, created: true } };
  }
  if (u.ifExists === "keep") return { ok: true, value: { id: keeper, created: false } };
  // Every row in one order first: each lock holds until commit, so two
  // writers over the same rows must take them in the same order.
  for (const rowId of rows) {
    const busy = await lockPrivateRow(tx, ctx, locker, operation, rowId);
    if (busy) return { ok: false, message: busy };
  }
  const names = Object.keys(u.values);
  if (names.length > 0) {
    const updated = await privateUpdate(
      tx,
      ctx,
      t,
      keeper,
      u.values,
      names.map((c) => sql`${col(c)} = ${u.bind(c, u.values[c])}`),
      locker,
      operation,
    );
    if (!updated.ok) return updated;
  }
  for (const rowId of rows.slice(1)) {
    const removed = await privateDelete(tx, ctx, t, rowId, locker, operation);
    if (!removed.ok) return removed;
  }
  return { ok: true, value: { id: keeper, created: false } };
}
