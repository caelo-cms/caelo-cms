// SPDX-License-Identifier: MPL-2.0

/**
 * Branch-aware handlers for the private zone (`plugin_storage.*`,
 * docs/branch-aware-plugin-storage.md §3–4).
 *
 * - **Main line** (no `ctx.chatBranchId`: Owner panel, workers, approved
 *   actions): writes change the live row and record a main snapshot, so
 *   the change is revertable like any core write.
 * - **Chat branch**: an insert creates the live row tagged with the
 *   branch (stable id, invisible to main); an update or delete records
 *   the row's full new state as a branch snapshot and leaves the live
 *   row untouched. Every branch write takes the row's `pluginRow` lock,
 *   so two unmerged chats cannot diverge on one row.
 * - **Reads** on a branch overlay the branch's latest state per row onto
 *   the main-line rows; on main they return main-line rows only.
 *
 * Rows travel as `to_jsonb` so a read returns the same value shapes on
 * main and on a branch (the overlay comes from JSON snapshots).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import {
  emitPluginRowSnapshot,
  loadBranchRowStates,
  type PluginRowOpKind,
  type PluginRowState,
  rowToState,
} from "./row-snapshots.js";

/**
 * Takes the `pluginRow` lock for a branch write. Supplied by the host
 * (admin-core owns chat locks); `null` means granted, a string is the
 * AI-facing reason the row is busy.
 */
export type PluginRowLocker = (
  tx: TransactionRunner,
  args: {
    readonly operation: string;
    readonly rowId: string;
    readonly chatBranchId: string;
    readonly chatTaskId: string | null;
  },
) => Promise<string | null>;

/** A parsed `list` filter; built once, applied as SQL and to overlay rows. */
export interface ListPlan {
  readonly limit: number;
  readonly orderBy: string | null;
  readonly orderDir: "asc" | "desc";
  readonly since: string | null;
  readonly equals: ReadonlyArray<readonly [string, unknown]>;
}

interface Target {
  readonly schema: string;
  readonly table: string;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

const table = (t: Target) => sql.raw(`"${t.schema}"."${t.table}"`);
const col = (name: string) => sql.raw(`"${name}"`);

function snapshotRef(ctx: ExecutionContext, t: Target, rowId: string) {
  if (!ctx.pluginId) throw new Error("plugin storage: no plugin id on the context");
  return { pluginId: ctx.pluginId, schema: t.schema, table: t.table, rowId };
}

async function snapshot(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  opKind: PluginRowOpKind,
  t: Target,
  rowId: string,
  state: PluginRowState,
): Promise<void> {
  await emitPluginRowSnapshot(tx, {
    ...snapshotRef(ctx, t, rowId),
    actorId: ctx.actorId,
    opKind,
    chatBranchId: ctx.chatBranchId ?? null,
    chatTaskId: ctx.chatTaskId ?? null,
    state,
  });
}

async function lock(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  locker: PluginRowLocker | undefined,
  operation: string,
  rowId: string,
): Promise<string | null> {
  if (!ctx.chatBranchId) return null;
  if (!locker) {
    // No fallback: an unlocked branch write could diverge from another chat.
    throw new Error(
      `${operation}: branch write without a row locker — the host must pass lockPluginRow in PluginHostInfra`,
    );
  }
  return locker(tx, {
    operation,
    rowId,
    chatBranchId: ctx.chatBranchId,
    chatTaskId: ctx.chatTaskId ?? null,
  });
}

async function liveRow(
  tx: TransactionRunner,
  t: Target,
  rowId: string,
  chatBranchId: string | undefined,
): Promise<Record<string, unknown> | null> {
  // A branch sees main rows plus the rows it created itself.
  const visible = chatBranchId
    ? sql`("caelo_chat_branch_id" IS NULL OR "caelo_chat_branch_id" = ${chatBranchId}::uuid)`
    : sql`"caelo_chat_branch_id" IS NULL`;
  const rows = (await tx.execute(sql`
    SELECT to_jsonb(t) AS row FROM ${table(t)} t WHERE t.id = ${rowId}::uuid AND ${visible}
  `)) as unknown as { row: Record<string, unknown> }[];
  return rows[0]?.row ?? null;
}

/** The row's current state as the caller sees it: branch overlay first, then live. */
async function currentState(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  rowId: string,
): Promise<PluginRowState | null> {
  if (ctx.chatBranchId && ctx.pluginId) {
    const branch = await loadBranchRowStates(tx, {
      pluginId: ctx.pluginId,
      table: t.table,
      chatBranchId: ctx.chatBranchId,
      rowIds: [rowId],
    });
    const state = branch.get(rowId);
    if (state) return state;
  }
  const row = await liveRow(tx, t, rowId, ctx.chatBranchId);
  return row ? rowToState(row) : null;
}

export async function privateInsert(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  cols: readonly string[],
  values: readonly ReturnType<typeof sql>[],
  locker: PluginRowLocker | undefined,
  operation: string,
): Promise<Outcome<{ id: string }>> {
  const allCols = [...cols.map((c) => `"${c}"`)];
  const allValues = [...values];
  if (ctx.chatBranchId) {
    allCols.push(`"caelo_chat_branch_id"`);
    allValues.push(sql`${ctx.chatBranchId}::uuid`);
  }
  const rows = (await tx.execute(sql`
    INSERT INTO ${table(t)} AS t (${sql.raw(allCols.join(", "))})
    VALUES (${sql.join(allValues, sql`, `)})
    RETURNING t.id::text AS id, to_jsonb(t) AS row
  `)) as unknown as { id: string; row: Record<string, unknown> }[];
  const inserted = rows[0];
  if (!inserted) return { ok: false, message: `${operation}: no id returned` };
  const busy = await lock(tx, ctx, locker, operation, inserted.id);
  if (busy) return { ok: false, message: busy };
  await snapshot(tx, ctx, "plugin_storage.insert", t, inserted.id, rowToState(inserted.row));
  return { ok: true, value: { id: inserted.id } };
}

export async function privateUpdate(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  rowId: string,
  patch: Readonly<Record<string, unknown>>,
  sets: readonly ReturnType<typeof sql>[],
  locker: PluginRowLocker | undefined,
  operation: string,
): Promise<Outcome<Record<string, never>>> {
  const busy = await lock(tx, ctx, locker, operation, rowId);
  if (busy) return { ok: false, message: busy };
  if (ctx.chatBranchId) {
    const current = await currentState(tx, ctx, t, rowId);
    if (!current || current.deletedAt !== null) return notFound(operation, rowId);
    const values = { ...current.values, ...patch, id: current.values.id };
    await snapshot(tx, ctx, "plugin_storage.update", t, rowId, {
      schemaVersion: 1,
      values,
      deletedAt: null,
      version: current.version + 1,
    });
    return { ok: true, value: {} };
  }
  const rows = (await tx.execute(sql`
    UPDATE ${table(t)} AS t
    SET ${sql.join([...sets, sql`"caelo_version" = t."caelo_version" + 1`, sql`"caelo_updated_at" = now()`], sql`, `)}
    WHERE t.id = ${rowId}::uuid AND t."caelo_deleted_at" IS NULL AND t."caelo_chat_branch_id" IS NULL
    RETURNING to_jsonb(t) AS row
  `)) as unknown as { row: Record<string, unknown> }[];
  const row = rows[0]?.row;
  if (!row) return notFound(operation, rowId);
  await snapshot(tx, ctx, "plugin_storage.update", t, rowId, rowToState(row));
  return { ok: true, value: {} };
}

export async function privateDelete(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  rowId: string,
  locker: PluginRowLocker | undefined,
  operation: string,
): Promise<Outcome<Record<string, never>>> {
  const busy = await lock(tx, ctx, locker, operation, rowId);
  if (busy) return { ok: false, message: busy };
  if (ctx.chatBranchId) {
    const current = await currentState(tx, ctx, t, rowId);
    if (!current || current.deletedAt !== null) return notFound(operation, rowId);
    await snapshot(tx, ctx, "plugin_storage.delete", t, rowId, {
      ...current,
      deletedAt: new Date().toISOString(),
      version: current.version + 1,
    });
    return { ok: true, value: {} };
  }
  // Soft delete: the last state stays for history and revert.
  const rows = (await tx.execute(sql`
    UPDATE ${table(t)} AS t
    SET "caelo_deleted_at" = now(), "caelo_version" = t."caelo_version" + 1, "caelo_updated_at" = now()
    WHERE t.id = ${rowId}::uuid AND t."caelo_deleted_at" IS NULL AND t."caelo_chat_branch_id" IS NULL
    RETURNING to_jsonb(t) AS row
  `)) as unknown as { row: Record<string, unknown> }[];
  const row = rows[0]?.row;
  if (!row) return notFound(operation, rowId);
  await snapshot(tx, ctx, "plugin_storage.delete", t, rowId, rowToState(row));
  return { ok: true, value: {} };
}

/**
 * Compare-and-swap one row. On main a single UPDATE checks and writes
 * atomically. On a chat branch the live row is not the chat's state, so
 * the check runs against the branch view: the row's `pluginRow` lock
 * keeps other chats out, and `FOR UPDATE` on the live row serialises
 * concurrent swaps within this chat — the second one re-reads the first
 * one's committed branch state and loses.
 */
export async function privateCompareAndSwap(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  rowId: string,
  change: {
    readonly expected: Readonly<Record<string, unknown>>;
    readonly patch: Readonly<Record<string, unknown>>;
    readonly conditions: readonly ReturnType<typeof sql>[];
    readonly sets: readonly ReturnType<typeof sql>[];
  },
  locker: PluginRowLocker | undefined,
  operation: string,
): Promise<Outcome<{ swapped: boolean }>> {
  if (ctx.chatBranchId) {
    const busy = await lock(tx, ctx, locker, operation, rowId);
    if (busy) return { ok: false, message: busy };
    await tx.execute(sql`SELECT id FROM ${table(t)} WHERE id = ${rowId}::uuid FOR UPDATE`);
    const current = await currentState(tx, ctx, t, rowId);
    if (!current || current.deletedAt !== null) return { ok: true, value: { swapped: false } };
    for (const [column, value] of Object.entries(change.expected)) {
      if (!jsonEqual(current.values[column] ?? null, value)) {
        return { ok: true, value: { swapped: false } };
      }
    }
    await snapshot(tx, ctx, "plugin_storage.update", t, rowId, {
      schemaVersion: 1,
      values: { ...current.values, ...change.patch, id: current.values.id },
      deletedAt: null,
      version: current.version + 1,
    });
    return { ok: true, value: { swapped: true } };
  }
  const rows = (await tx.execute(sql`
    UPDATE ${table(t)} AS t
    SET ${sql.join([...change.sets, sql`"caelo_version" = t."caelo_version" + 1`, sql`"caelo_updated_at" = now()`], sql`, `)}
    WHERE t.id = ${rowId}::uuid AND t."caelo_deleted_at" IS NULL AND t."caelo_chat_branch_id" IS NULL
      AND ${sql.join([...change.conditions], sql` AND `)}
    RETURNING to_jsonb(t) AS row
  `)) as unknown as { row: Record<string, unknown> }[];
  const row = rows[0]?.row;
  if (!row) return { ok: true, value: { swapped: false } };
  await snapshot(tx, ctx, "plugin_storage.update", t, rowId, rowToState(row));
  return { ok: true, value: { swapped: true } };
}

/** JSON equality as Postgres' jsonb compares: object key order does not matter. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/**
 * May this plugin touch its private storage right now? Runs first in every
 * private storage operation, in the operation's own transaction: it holds
 * the plugin's registry row `FOR SHARE`, so disabling the plugin or
 * revoking its grant (both lock that row) waits for an accepted write to
 * commit, and no write starts after the revocation committed.
 *
 * A plugin installed as an external artifact additionally needs an
 * unrevoked `cms_admin_schema` receipt for the artifact it runs
 * (CMS_REQUIREMENTS §14.5).
 *
 * @returns null when allowed, else the reason
 */
export function privateStorageRefusal(
  tx: TransactionRunner,
  ctx: ExecutionContext,
): Promise<string | null> {
  return privateGrantRefusal(tx, ctx, "cms_admin_schema");
}

/**
 * The same check for any author-side grant (`cms_admin_schema`,
 * `private_files`): plugin active, and — for an installed artifact — that
 * exact artifact active with an unrevoked receipt for `capability`.
 */
export async function privateGrantRefusal(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  capability: "cms_admin_schema" | "private_files",
): Promise<string | null> {
  if (!ctx.pluginId) return "no plugin id on the context";
  // Statement 1 takes the lock. Statement 2 runs after it, so under READ
  // COMMITTED it sees whatever a finalize or revocation committed while
  // this one waited — a single statement would keep its earlier snapshot
  // for the joined rows.
  const plugin = (await tx.execute(sql`
    SELECT status FROM plugins WHERE id = ${ctx.pluginId}::uuid FOR SHARE
  `)) as unknown as { status: string }[];
  if (plugin[0]?.status !== "active") return "the plugin is not active";
  const rows = (await tx.execute(sql`
    SELECT v.artifact_digest,
           EXISTS (
             SELECT 1 FROM plugin_capability_grants g
             WHERE g.plugin_id = v.plugin_id AND g.artifact_digest = v.artifact_digest
               AND g.capability = ${capability} AND g.revoked_at IS NULL
           ) AS granted
    FROM plugin_installation_versions v
    WHERE v.plugin_id = ${ctx.pluginId}::uuid AND v.status = 'active'
  `)) as unknown as { artifact_digest: string; granted: boolean }[];
  const active = rows[0];
  if (ctx.pluginArtifactDigest !== undefined) {
    // An installed artifact may write only while it is the active,
    // granted one — not a successor finalised while it was running.
    if (!active || active.artifact_digest !== ctx.pluginArtifactDigest) {
      return "this plugin version is no longer the active one — reload it";
    }
  }
  if (active && !active.granted) {
    return `the Owner has not granted (or has revoked) ${capability === "private_files" ? "private files" : "private storage"} for this plugin version`;
  }
  return null;
}

function notFound(operation: string, rowId: string): { ok: false; message: string } {
  return {
    ok: false,
    message: `${operation}: row ${rowId} not found (or already deleted) — list the table to get current ids`,
  };
}

export async function privateList(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  t: Target,
  plan: ListPlan,
): Promise<Record<string, unknown>[]> {
  const overlay =
    ctx.chatBranchId && ctx.pluginId
      ? await loadBranchRowStates(tx, {
          pluginId: ctx.pluginId,
          table: t.table,
          chatBranchId: ctx.chatBranchId,
        })
      : new Map<string, PluginRowState>();

  const wheres = [sql`t."caelo_deleted_at" IS NULL`, sql`t."caelo_chat_branch_id" IS NULL`];
  // Rows the branch touched come from the overlay instead.
  if (overlay.size > 0) {
    wheres.push(
      sql`t.id NOT IN (${sql.join(
        [...overlay.keys()].map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  }
  if (plan.since !== null) wheres.push(sql`t."created_at" > ${plan.since}`);
  for (const [k, v] of plan.equals) wheres.push(sql`t.${col(k)} = ${v}`);
  const orderSql = plan.orderBy
    ? sql.raw(`ORDER BY t."${plan.orderBy}" ${plan.orderDir.toUpperCase()}`)
    : sql.raw("");
  const rows = (await tx.execute(sql`
    SELECT to_jsonb(t) AS row FROM ${table(t)} t
    WHERE ${sql.join(wheres, sql` AND `)} ${orderSql} ${sql.raw(`LIMIT ${plan.limit}`)}
  `)) as unknown as { row: Record<string, unknown> }[];
  const main = rows.map((r) => rowToState(r.row).values);
  if (overlay.size === 0) return main;

  const branchRows = [...overlay.values()]
    .filter((s) => s.deletedAt === null && matches(s.values, plan))
    .map((s) => s.values);
  const merged = [...main, ...branchRows];
  if (plan.orderBy) {
    const key = plan.orderBy;
    const dir = plan.orderDir === "asc" ? 1 : -1;
    merged.sort((a, b) => dir * compare(a[key], b[key]));
  }
  return merged.slice(0, plan.limit);
}

function matches(values: Readonly<Record<string, unknown>>, plan: ListPlan): boolean {
  if (plan.since !== null && !(compare(values.created_at, plan.since) > 0)) return false;
  return plan.equals.every(([k, v]) => sameValue(values[k], v));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return String(a) === String(b);
}

/** Order like Postgres for the shapes `to_jsonb` yields: numbers, strings (incl. ISO timestamps), booleans; NULLs last. */
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string" && isTimestamp(a) && isTimestamp(b)) {
    return Date.parse(a) - Date.parse(b);
  }
  return String(a) < String(b) ? -1 : 1;
}

function isTimestamp(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
}
