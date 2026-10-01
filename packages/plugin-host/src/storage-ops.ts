// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin storage as named Query API operations (CMS_REQUIREMENTS §14.7).
 *
 * Every read and write a plugin makes to its own tables goes through one
 * of these operations instead of SQL issued by the host, so it passes the
 * same Validator and adapter as every other database access. Two zones:
 *
 * - **private** (`plugin_storage.*`, `cms_admin`) — the plugin's
 *   author-side tables. Host-owned columns (`caelo_chat_branch_id`,
 *   `caelo_deleted_at`, `caelo_version`, `caelo_updated_at`) carry the
 *   branch and history state; deletes are soft. Writes from a chat land
 *   on the chat's branch, writes without one go live with a snapshot;
 *   reads see the caller's branch (private-storage.ts). A plugin can
 *   neither read nor write a host column.
 * - **public** (`plugin_public_storage.*`, `cms_public`) — visitor data
 *   such as form submissions. Unchanged semantics: live, hard delete.
 *
 * Isolation does not rest on these handlers: every plugin table carries
 * an RLS policy on `caelo.plugin_id`, which the adapter sets from the
 * caller's context. A handler handed another plugin's schema reads and
 * writes nothing.
 *
 * The host broker (capabilities.ts) validates a call against the
 * plugin's manifest and passes the declared column map for the table;
 * the handlers re-check every identifier and column against it.
 */

import {
  defineOperation,
  type OperationDefinition,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  type ListPlan,
  type PluginRowLocker,
  privateCompareAndSwap,
  privateDelete,
  privateInsert,
  privateList,
  privateUpdate,
} from "./private-storage.js";

/** Identifiers interpolated into SQL: lowercase, underscore, ≤63 chars. */
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const ident = z.string().regex(IDENT_RE);
const HOST_COLUMN_PREFIX = "caelo_";

const base = {
  schema: ident,
  table: ident,
  /** The table's declared columns → declared type, from the manifest. */
  columns: z.record(ident, z.string().min(1).max(200)),
};

const insertInput = z.object({ ...base, data: z.record(z.string(), z.unknown()) }).strict();
const listInput = z
  .object({ ...base, filter: z.record(z.string(), z.unknown()).optional() })
  .strict();
const updateInput = z
  .object({ ...base, id: z.string().uuid(), patch: z.record(z.string(), z.unknown()) })
  .strict();
const deleteInput = z.object({ ...base, id: z.string().uuid() }).strict();
const casInput = z
  .object({
    ...base,
    id: z.string().uuid(),
    expected: z.record(z.string(), z.unknown()),
    patch: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * The predicate and assignments of a compare-and-swap, or the reason the
 * call is refused. `id` may be expected but never patched; host-owned
 * and undeclared columns are refused on both sides.
 */
function casFragments(
  op: string,
  columns: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): { conditions: ReturnType<typeof sql>[]; sets: ReturnType<typeof sql>[] } | string {
  const conditions: ReturnType<typeof sql>[] = [];
  const sets: ReturnType<typeof sql>[] = [];
  for (const [values, matching] of [
    [expected, true],
    [patch, false],
  ] as const) {
    const entries = Object.entries(values);
    if (entries.length === 0 || entries.length > 64) {
      return `${op}: expected and patch must each contain 1..64 columns`;
    }
    for (const [column, value] of entries) {
      const declared = column === "id" || checkColumn(op, columns, column) === null;
      if (!IDENT_RE.test(column) || !declared || (!matching && column === "id")) {
        return `${op}: column "${column}" is undeclared or immutable`;
      }
      if (value === undefined) {
        return `${op}: undefined is not a stored value; use null explicitly`;
      }
      const name = sql.raw(`"${column}"`);
      const param = valueSql(columns, column, value);
      if (matching) conditions.push(sql`t.${name} IS NOT DISTINCT FROM ${param}`);
      else sets.push(sql`${name} = ${param}`);
    }
  }
  return { conditions, sets };
}

type Zone = "private" | "public";

function fail(operation: string, message: string) {
  return err({ kind: "HandlerError" as const, operation, message });
}

/** A column the caller may touch: declared, a safe identifier, not host-owned. */
function checkColumn(
  operation: string,
  columns: Readonly<Record<string, string>>,
  column: string,
): string | null {
  if (!IDENT_RE.test(column)) return `${operation}: refusing column "${column}"`;
  if (column.startsWith(HOST_COLUMN_PREFIX))
    return `${operation}: column "${column}" is host-owned and cannot be read or written by a plugin`;
  if (!(column in columns)) return `${operation}: column "${column}" is not declared`;
  return null;
}

function valueSql(columns: Readonly<Record<string, string>>, column: string, value: unknown) {
  // A jsonb object/array must travel as ONE parameter: bound straight
  // into the template drizzle expands an array into a SQL tuple.
  return columns[column] === "jsonb" && value !== null && typeof value === "object"
    ? sql`${sql.param(value)}`
    : sql`${value}`;
}

/** Parse a `list` filter once; the private zone applies it as SQL and to overlay rows. */
function parseListFilter(
  op: string,
  columns: Readonly<Record<string, string>>,
  filter: Readonly<Record<string, unknown>>,
): ListPlan | string {
  let limit = 100;
  let orderBy: string | null = null;
  let orderDir: "asc" | "desc" = "desc";
  let since: string | null = null;
  const equals: [string, unknown][] = [];
  for (const [k, v] of Object.entries(filter)) {
    if (k === "limit") {
      if (typeof v !== "number" || v <= 0 || v > 1000) return `${op}: limit must be 1..1000`;
      limit = v;
    } else if (k === "orderBy") {
      if (typeof v !== "string") return `${op}: orderBy must be string`;
      const problem = checkColumn(op, columns, v);
      if (problem) return problem;
      orderBy = v;
    } else if (k === "orderDir") {
      if (v !== "asc" && v !== "desc") return `${op}: orderDir must be asc|desc`;
      orderDir = v;
    } else if (k === "since") {
      if (typeof v !== "string") return `${op}: since must be ISO timestamp string`;
      if (!("created_at" in columns)) return `${op}: \`since\` requires a created_at column`;
      since = v;
    } else {
      const problem = checkColumn(op, columns, k);
      if (problem) return problem;
      equals.push([k, v]);
    }
  }
  return { limit, orderBy, orderDir, since, equals };
}

function makeOps(zone: Zone, locker: PluginRowLocker | undefined) {
  const family = zone === "private" ? "plugin_storage" : "plugin_public_storage";
  const database = zone === "private" ? "cms_admin" : "cms_public";
  const table = (schema: string, name: string) => sql.raw(`"${schema}"."${name}"`);
  const pluginOnly = (ctx: ExecutionContext, operation: string) =>
    ctx.actorKind === "plugin" && ctx.pluginId
      ? null
      : fail(operation, `${operation}: only a plugin can use its own storage`);
  const settle = <T>(
    operation: string,
    r: { ok: true; value: T } | { ok: false; message: string },
  ) => (r.ok ? ok(r.value) : fail(operation, r.message));

  const insert = defineOperation({
    name: `${family}.insert`,
    // Why plugin-only: the caller's plugin id scopes the RLS policy; any
    // other actor has no storage of its own here.
    actorScope: ["plugin"],
    database,
    input: insertInput,
    output: z.object({ id: z.string() }),
    handler: async (ctx, input, tx) => {
      const op = `${family}.insert`;
      const denied = pluginOnly(ctx, op);
      if (denied) return denied;
      const cols: string[] = [];
      const values: ReturnType<typeof sql>[] = [];
      for (const [k, v] of Object.entries(input.data)) {
        const problem = checkColumn(op, input.columns, k);
        if (problem) return fail(op, problem);
        cols.push(k);
        values.push(valueSql(input.columns, k, v));
      }
      if (cols.length === 0)
        return fail(op, `${op}: data must include at least one declared column`);
      if (zone === "private") {
        return settle(op, await privateInsert(tx, ctx, input, cols, values, locker, op));
      }
      const rows = (await tx.execute(
        sql`INSERT INTO ${table(input.schema, input.table)} (${sql.raw(cols.map((c) => `"${c}"`).join(", "))}) VALUES (${sql.join(values, sql`, `)}) RETURNING id::text AS id`,
      )) as unknown as { id: string }[];
      const id = rows[0]?.id;
      if (!id) return fail(op, `${op}: no id returned`);
      return ok({ id });
    },
  });

  const list = defineOperation({
    name: `${family}.list`,
    // Why plugin-only: see insert.
    actorScope: ["plugin"],
    database,
    input: listInput,
    output: z.object({ rows: z.array(z.record(z.string(), z.unknown())) }),
    handler: async (ctx, input, tx) => {
      const op = `${family}.list`;
      const denied = pluginOnly(ctx, op);
      if (denied) return denied;
      const plan = parseListFilter(op, input.columns, input.filter ?? {});
      if (typeof plan === "string") return fail(op, plan);
      if (zone === "private") return ok({ rows: await privateList(tx, ctx, input, plan) });
      const wheres: ReturnType<typeof sql>[] = [];
      if (plan.since !== null) wheres.push(sql`"created_at" > ${plan.since}`);
      for (const [k, v] of plan.equals) wheres.push(sql`${sql.raw(`"${k}"`)} = ${v}`);
      const whereSql =
        wheres.length === 0 ? sql.raw("") : sql`WHERE ${sql.join(wheres, sql` AND `)}`;
      const orderSql = plan.orderBy
        ? sql.raw(`ORDER BY "${plan.orderBy}" ${plan.orderDir.toUpperCase()}`)
        : sql.raw("");
      const rows = (await tx.execute(
        sql`SELECT * FROM ${table(input.schema, input.table)} ${whereSql} ${orderSql} ${sql.raw(`LIMIT ${plan.limit}`)}`,
      )) as unknown as Record<string, unknown>[];
      return ok({ rows });
    },
  });

  const update = defineOperation({
    name: `${family}.update`,
    // Why plugin-only: see insert.
    actorScope: ["plugin"],
    database,
    input: updateInput,
    output: z.object({}),
    handler: async (ctx, input, tx) => {
      const op = `${family}.update`;
      const denied = pluginOnly(ctx, op);
      if (denied) return denied;
      const sets: ReturnType<typeof sql>[] = [];
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input.patch)) {
        if (k === "id") continue; // never update id
        const problem = checkColumn(op, input.columns, k);
        if (problem) return fail(op, problem);
        sets.push(sql`${sql.raw(`"${k}"`)} = ${valueSql(input.columns, k, v)}`);
        patch[k] = v;
      }
      if (sets.length === 0)
        return fail(op, `${op}: patch must include at least one declared column`);
      if (zone === "private") {
        return settle(op, await privateUpdate(tx, ctx, input, input.id, patch, sets, locker, op));
      }
      await tx.execute(
        sql`UPDATE ${table(input.schema, input.table)} SET ${sql.join(sets, sql`, `)} WHERE id = ${input.id}::uuid`,
      );
      return ok({});
    },
  });

  const remove = defineOperation({
    name: `${family}.delete`,
    // Why plugin-only: see insert.
    actorScope: ["plugin"],
    database,
    input: deleteInput,
    output: z.object({}),
    handler: async (ctx, input, tx) => {
      const op = `${family}.delete`;
      const denied = pluginOnly(ctx, op);
      if (denied) return denied;
      if (zone === "private") {
        return settle(op, await privateDelete(tx, ctx, input, input.id, locker, op));
      }
      await tx.execute(
        sql`DELETE FROM ${table(input.schema, input.table)} WHERE id = ${input.id}::uuid`,
      );
      return ok({});
    },
  });

  const compareAndSwap = defineOperation({
    name: `${family}.compare_and_swap`,
    // Why plugin-only: see insert.
    actorScope: ["plugin"],
    database,
    input: casInput,
    output: z.object({ swapped: z.boolean() }),
    handler: async (ctx, input, tx) => {
      const op = `${family}.compare_and_swap`;
      const denied = pluginOnly(ctx, op);
      if (denied) return denied;
      const fragments = casFragments(op, input.columns, input.expected, input.patch);
      if (typeof fragments === "string") return fail(op, fragments);
      if (zone === "private") {
        return settle(
          op,
          await privateCompareAndSwap(
            tx,
            ctx,
            input,
            input.id,
            { expected: input.expected, patch: input.patch, ...fragments },
            locker,
            op,
          ),
        );
      }
      // One statement: the check and the write cannot interleave.
      const rows = (await tx.execute(
        sql`UPDATE ${table(input.schema, input.table)} AS t SET ${sql.join(fragments.sets, sql`, `)} WHERE t.id = ${input.id}::uuid AND ${sql.join(fragments.conditions, sql` AND `)} RETURNING t.id`,
      )) as unknown as unknown[];
      return ok({ swapped: rows.length === 1 });
    },
  });

  return [insert, list, update, remove, compareAndSwap];
}

/** Operation names by zone, for the host broker. */
export const STORAGE_OPS = {
  private: {
    insert: "plugin_storage.insert",
    list: "plugin_storage.list",
    update: "plugin_storage.update",
    delete: "plugin_storage.delete",
    compareAndSwap: "plugin_storage.compare_and_swap",
  },
  public: {
    insert: "plugin_public_storage.insert",
    list: "plugin_public_storage.list",
    update: "plugin_public_storage.update",
    delete: "plugin_public_storage.delete",
    compareAndSwap: "plugin_public_storage.compare_and_swap",
  },
} as const;

/**
 * Register the storage operations on a registry. Idempotent: the admin
 * app, the gateway and tests each bootstrap their own registry. The
 * first registration binds `lockPluginRow`; a branch write on a registry
 * registered without one fails loudly.
 */
export function registerPluginStorageOps(
  registry: OperationRegistry,
  deps: { readonly lockPluginRow?: PluginRowLocker } = {},
): void {
  if (registry.has(STORAGE_OPS.private.insert)) return;
  for (const op of [
    ...makeOps("private", deps.lockPluginRow),
    ...makeOps("public", deps.lockPluginRow),
  ]) {
    // The registry stores every op as OperationDefinition<unknown, unknown>.
    if (!registry.has(op.name)) registry.register(op as OperationDefinition<unknown, unknown>);
  }
}
