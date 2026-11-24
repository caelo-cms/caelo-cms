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
 * 2. Rows of the key in the caller's view (main rows plus its branch's
 *    pending states): the first by id is updated, the others are deleted —
 *    rows that came to share the key before. These are ordinary writes: on
 *    a chat branch each one takes the row's lock first, so a change by
 *    another chat in the shared draft that this chat has not seen is the
 *    usual conflict (it names `get_plugin_draft_rows`, #1387).
 * 3. Otherwise a row of the key that another branch created and has not
 *    staged, which the caller cannot see. A chat takes it over — across
 *    branches a write adopts the other branch's pending change (#620) —
 *    and the row moves to the chat's branch with it. The main line writes
 *    its state onto that row, which becomes the key's main-line row; the
 *    branch's pending state applies over it at the branch's Stage, as a
 *    merge does for every row (last writer wins).
 * 4. Otherwise an insert.
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
  /** 1–4 key columns and their values. */
  readonly key: Readonly<Record<string, string | number | boolean>>;
  /** The other columns written on insert and on update (may be empty). */
  readonly values: Readonly<Record<string, unknown>>;
  /** A key or values column's value, bound as the column's type needs. */
  readonly sqlOf: (column: string) => SQL;
  readonly ifExists: "update" | "keep";
}

interface Target {
  readonly schema: string;
  readonly table: string;
  readonly columns: Readonly<Record<string, string>>;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

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

/**
 * The lock's name: plugin, table and key, the values as text (the column's
 * type decides equality, so `1` and `"1"` name the same row and must take
 * the same lock).
 */
function keyLockName(pluginId: string, t: Target, key: UpsertWrite["key"]): string {
  const pairs = Object.entries(key)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([pluginId, t.schema, t.table, pairs]);
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
  const visible = [
    ...main.map((r) => String(r.row.id)),
    ...[...overlay.entries()]
      .filter(([, s]) => s.deletedAt === null && overlayRowMatches(s.values, plan))
      .map(([id]) => String(id)),
  ].sort();

  const keeper = visible[0];
  if (keeper !== undefined) {
    if (u.ifExists === "keep") return { ok: true, value: { id: keeper, created: false } };
    // Every row in one order first: each lock holds until commit, so two
    // writers over the same rows must take them in the same order.
    for (const rowId of visible) {
      const busy = await lockPrivateRow(tx, ctx, locker, operation, rowId);
      if (busy) return { ok: false, message: busy };
    }
    const updated = await updateWith(tx, ctx, t, keeper, u, locker, operation);
    if (!updated.ok) return updated;
    for (const rowId of visible.slice(1)) {
      const removed = await privateDelete(tx, ctx, t, rowId, locker, operation);
      if (!removed.ok) return removed;
    }
    return { ok: true, value: { id: keeper, created: false } };
  }

  const other = await otherBranchRow(tx, ctx, pluginId, t, u);
  if (other && ctx.chatBranchId) {
    return takeOver(tx, ctx, t, u, other, locker, operation);
  }
  if (other) return adoptOnMain(tx, ctx, t, u, other, operation);

  const columns = [...Object.keys(u.key), ...Object.keys(u.values)];
  const inserted = await privateInsert(
    tx,
    ctx,
    t,
    columns,
    columns.map((c) => u.sqlOf(c)),
    locker,
    operation,
  );
  if (!inserted.ok) return inserted;
  return { ok: true, value: { id: inserted.value.id, created: true } };
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
    names.map((c) => sql`${col(c)} = ${u.sqlOf(c)}`),
    locker,
    operation,
  );
}

interface OtherBranchRow {
  readonly id: string;
  readonly branch: string;
}

/**
 * The key's row another branch created and still holds as a live pending
 * row, or null. A row its branch has deleted again is no row of the key:
 * that branch's Stage keeps it deleted.
 */
async function otherBranchRow(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  pluginId: string,
  t: Target,
  u: UpsertWrite,
): Promise<OtherBranchRow | null> {
  const keyWhere = Object.keys(u.key).map((c) => sql`t.${col(c)} = ${u.sqlOf(c)}`);
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
  for (const row of rows) {
    const states = await loadBranchRowStates(tx, {
      pluginId,
      table: t.table,
      chatBranchId: row.branch,
      rowIds: [row.id],
    });
    const state = states.get(row.id);
    if (state === undefined || state.deletedAt === null) return row;
  }
  return null;
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
  u: UpsertWrite,
  other: OtherBranchRow,
  locker: PluginRowLocker | undefined,
  operation: string,
): Promise<Outcome<{ id: string; created: boolean }>> {
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
  if (u.ifExists === "keep") return { ok: true, value: { id: other.id, created: false } };
  const updated = await updateWith(tx, ctx, t, other.id, u, locker, operation);
  if (!updated.ok) return updated;
  return { ok: true, value: { id: other.id, created: false } };
}

/**
 * The main line writes a key whose row a branch created: the main state
 * goes onto that row — every declared column as an insert would set it —
 * and the row becomes the key's main-line row. The branch keeps its
 * pending state of the row (its own view is unchanged), and its Stage
 * applies it over the main state.
 */
async function adoptOnMain(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  u: UpsertWrite,
  other: OtherBranchRow,
  operation: string,
): Promise<Outcome<{ id: string; created: boolean }>> {
  const given = new Set([...Object.keys(u.key), ...Object.keys(u.values)]);
  const sets = Object.keys(t.columns)
    .filter((c) => c !== "id")
    .map((c) => (given.has(c) ? sql`${col(c)} = ${u.sqlOf(c)}` : sql`${col(c)} = DEFAULT`));
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
  return { ok: true, value: { id: other.id, created: true } };
}
