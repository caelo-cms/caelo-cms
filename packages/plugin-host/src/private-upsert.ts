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
 *   branches, and each Stage carries its row to main.
 *
 * The rows of one key then disagree, and which one a read takes depends on
 * their order. An upsert keeps the key at one row instead:
 *
 * 1. A transaction lock on the key serialises every upsert of it. Each
 *    statement after the lock sees what committed before it (READ
 *    COMMITTED), so the later upsert finds the earlier one's row.
 * 2. The key's rows are the ones the caller sees (main rows plus its
 *    branch's pending states) and the ones other branches created and have
 *    not staged, which it cannot see.
 * 3. A chat takes every row of the key another branch holds over (across
 *    branches a write adopts the other branch's pending change, #620); each
 *    moves to the chat's branch with its change. Then the first row by id
 *    is updated and the others are deleted. These are ordinary writes: each
 *    takes the row's lock first, so a change by another chat in the shared
 *    draft that this chat has not seen is the usual conflict (it names
 *    `get_plugin_draft_rows`, #1387).
 * 4. The main line cannot take a branch's change. When a branch holds a row
 *    of the key, that row becomes the key's main-line row: the main state
 *    goes onto it and the main rows of the key are deleted. The branch keeps
 *    its pending state of the row and applies it at its Stage, as a merge
 *    does for every row (last writer wins), so the Stage leaves one row.
 *    Without a branch row, the main rows fold as in 3.
 * 5. A key without any row gets an insert.
 *
 * `ifExists: "keep"` changes nothing when the caller sees a row of the key.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { loadBranchOverlay } from "./branch-overlay.js";
import {
  type ListPlan,
  lockPrivateRow,
  overlayRowMatches,
  type PluginRowLocker,
  privateDelete,
  privateInsert,
  privateListSql,
  privateUpdate,
  snapshotPrivateRow,
} from "./private-storage.js";
import { loadBranchRowStates, rowToState } from "./row-snapshots.js";

/** Advisory lock class of an upsert's key (the `hashtextextended` seed). */
const UPSERT_KEY_LOCK_SEED = 1659;

/** Rows of one key one upsert folds at most (the ceiling of one read). */
export const UPSERT_FOLD_MAX = 1000;

/** One upsert, its columns already checked against the table's declaration. */
export interface UpsertWrite {
  /**
   * 1–4 key columns and their values, normalised to the column's type (a
   * uuid in lowercase), so equal keys name one lock and match one row.
   */
  readonly key: Readonly<Record<string, string | number | boolean>>;
  /** The other columns written on insert and on update (may be empty). */
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
type Upserted = Outcome<{ id: string; created: boolean }>;

const tableSql = (t: Target) => sql.raw(`"${t.schema}"."${t.table}"`);
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

/** The lock's name: plugin, table and the (normalised) key. */
function keyLockName(pluginId: string, t: Target, key: UpsertWrite["key"]): string {
  const pairs = Object.entries(key).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([pluginId, t.schema, t.table, pairs]);
}

/** A key or values column's value from the write. */
function given(u: UpsertWrite, column: string): unknown {
  return column in u.key ? u.key[column] : u.values[column];
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
): Promise<Upserted> {
  const pluginId = ctx.pluginId;
  if (!pluginId) throw new Error("plugin storage: no plugin id on the context");
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${keyLockName(pluginId, t, u.key)}, ${UPSERT_KEY_LOCK_SEED}))`,
  );

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
  const mainValues = new Map(main.map((r) => [String(r.row.id), rowToState(r.row).values]));
  const visible = [
    ...mainValues.keys(),
    ...[...overlay.entries()]
      .filter(([, s]) => s.deletedAt === null && overlayRowMatches(s.values, plan))
      .map(([id]) => String(id)),
  ].sort();
  if (u.ifExists === "keep" && visible[0] !== undefined) {
    return { ok: true, value: { id: visible[0], created: false } };
  }
  const hidden = await otherBranchRows(tx, ctx, pluginId, t, u);

  if (!ctx.chatBranchId && hidden[0]) {
    return adoptOnMain(tx, ctx, t, u, hidden[0], visible, mainValues, locker, operation);
  }
  for (const row of hidden) {
    const taken = await takeOver(tx, ctx, t, row, locker, operation);
    if (!taken.ok) return taken;
  }
  const rows = [...visible, ...hidden.map((h) => h.id)].sort();
  const keeper = rows[0];
  if (keeper === undefined) {
    const columns = [...Object.keys(u.key), ...Object.keys(u.values)];
    const inserted = await privateInsert(
      tx,
      ctx,
      t,
      columns,
      columns.map((c) => u.bind(c, given(u, c))),
      locker,
      operation,
    );
    if (!inserted.ok) return inserted;
    return { ok: true, value: { id: inserted.value.id, created: true } };
  }
  // Every row in one order first: each lock holds until commit, so two
  // writers over the same rows must take them in the same order.
  for (const rowId of rows) {
    const busy = await lockPrivateRow(tx, ctx, locker, operation, rowId);
    if (busy) return { ok: false, message: busy };
  }
  // Keep mode gets here only when every row was another branch's (taken
  // over above): their state stays, only the extra rows go.
  if (u.ifExists === "update") {
    const updated = await updateWith(tx, ctx, t, keeper, u, locker, operation);
    if (!updated.ok) return updated;
  }
  for (const rowId of rows.slice(1)) {
    const removed = await privateDelete(tx, ctx, t, rowId, locker, operation);
    if (!removed.ok) return removed;
  }
  return { ok: true, value: { id: keeper, created: false } };
}

/** Write `u.values` onto a row the caller sees (nothing when there are none). */
async function updateWith(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  rowId: string,
  u: UpsertWrite,
  locker: PluginRowLocker | undefined,
  operation: string,
): Promise<Outcome<Record<string, never>>> {
  const names = Object.keys(u.values);
  if (names.length === 0) return { ok: true, value: {} };
  return privateUpdate(
    tx,
    ctx,
    t,
    rowId,
    u.values,
    names.map((c) => sql`${col(c)} = ${u.bind(c, u.values[c])}`),
    locker,
    operation,
  );
}

interface OtherBranchRow {
  readonly id: string;
  readonly branch: string;
}

/**
 * The key's rows other branches created and still hold as live pending
 * rows, by id. A row its branch has deleted again is no row of the key:
 * that branch's Stage keeps it deleted.
 */
async function otherBranchRows(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  pluginId: string,
  t: Target,
  u: UpsertWrite,
): Promise<OtherBranchRow[]> {
  const keyWhere = Object.keys(u.key).map((c) => sql`t.${col(c)} = ${u.bind(c, u.key[c])}`);
  const notMine = ctx.chatBranchId
    ? sql`AND t."caelo_chat_branch_id" <> ${ctx.chatBranchId}::uuid`
    : sql``;
  const rows = (await tx.execute(sql`
    SELECT t.id::text AS id, t."caelo_chat_branch_id"::text AS branch
    FROM ${tableSql(t)} t
    WHERE t."caelo_chat_branch_id" IS NOT NULL AND t."caelo_deleted_at" IS NULL ${notMine}
      AND ${sql.join(keyWhere, sql` AND `)}
    ORDER BY t.id
    LIMIT ${UPSERT_FOLD_MAX}
  `)) as unknown as OtherBranchRow[];
  const live: OtherBranchRow[] = [];
  for (const row of rows) {
    const states = await loadBranchRowStates(tx, {
      pluginId,
      table: t.table,
      chatBranchId: row.branch,
      rowIds: [row.id],
    });
    const state = states.get(row.id);
    if (state === undefined || state.deletedAt === null) live.push(row);
  }
  return live;
}

/**
 * A chat writes a key whose row another branch created: the row's lock
 * takes that branch's pending change over (it moves to this chat, #620),
 * and the row moves to this chat's branch with it, so this chat sees it
 * and a discard of the other branch no longer drops it.
 */
async function takeOver(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  other: OtherBranchRow,
  locker: PluginRowLocker | undefined,
  operation: string,
): Promise<Outcome<Record<string, never>>> {
  const branchId = ctx.chatBranchId as string;
  const pluginId = ctx.pluginId as string;
  const busy = await lockPrivateRow(tx, ctx, locker, operation, other.id);
  if (busy) return { ok: false, message: busy };
  const left = await loadBranchRowStates(tx, {
    pluginId,
    table: t.table,
    chatBranchId: other.branch,
    rowIds: [other.id],
  });
  if (left.size > 0) {
    // No fallback: moving the row without its pending change would leave
    // that change to merge onto a row this chat now holds.
    return {
      ok: false,
      message: `${operation}: the "${t.table}" row ${other.id} of this key is an unstaged change of another chat that could not be taken over — nothing was written. Ask the operator to Stage or undo that chat's changes (Open changes in the editor), then send the call again`,
    };
  }
  await tx.execute(sql`
    UPDATE ${tableSql(t)} SET "caelo_chat_branch_id" = ${branchId}::uuid
    WHERE id = ${other.id}::uuid AND "caelo_chat_branch_id" = ${other.branch}::uuid
  `);
  return { ok: true, value: {} };
}

/**
 * The main line writes a key a branch holds a row of: that row becomes the
 * key's main-line row, holding the main state — the written values over
 * the key's current main row, every other declared column as an insert
 * would set it — and the key's main rows are deleted. The branch keeps its
 * pending state of the row (its own view is unchanged), and its Stage
 * applies it over the main state. (Keep mode reaches this only for a key
 * without a main row: it changes nothing where one exists.)
 */
async function adoptOnMain(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  u: UpsertWrite,
  other: OtherBranchRow,
  mainRows: readonly string[],
  mainValues: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  locker: PluginRowLocker | undefined,
  operation: string,
): Promise<Upserted> {
  const current = mainRows[0] === undefined ? undefined : mainValues.get(mainRows[0]);
  const sets = Object.keys(t.columns)
    .filter((c) => c !== "id")
    .map((c) => {
      if (c in u.key || c in u.values) return sql`${col(c)} = ${u.bind(c, given(u, c))}`;
      if (current && c in current) return sql`${col(c)} = ${u.bind(c, current[c])}`;
      return sql`${col(c)} = DEFAULT`;
    });
  const rows = (await tx.execute(sql`
    UPDATE ${tableSql(t)} AS t
    SET ${sql.join(
      [
        ...sets,
        sql`"caelo_chat_branch_id" = NULL`,
        sql`"caelo_version" = t."caelo_version" + 1`,
        sql`"caelo_updated_at" = now()`,
      ],
      sql`, `,
    )}
    WHERE t.id = ${other.id}::uuid AND t."caelo_chat_branch_id" = ${other.branch}::uuid
      AND t."caelo_deleted_at" IS NULL
    RETURNING to_jsonb(t) AS row
  `)) as unknown as { row: Record<string, unknown> }[];
  const row = rows[0]?.row;
  if (!row) {
    // The key's lock is held and the row was read in this transaction.
    throw new Error(`${operation}: the "${t.table}" row ${other.id} vanished under the key lock`);
  }
  await snapshotPrivateRow(tx, ctx, "plugin_storage.insert", t, other.id, rowToState(row));
  for (const rowId of mainRows) {
    const removed = await privateDelete(tx, ctx, t, rowId, locker, operation);
    if (!removed.ok) return removed;
  }
  return { ok: true, value: { id: other.id, created: mainRows.length === 0 } };
}
