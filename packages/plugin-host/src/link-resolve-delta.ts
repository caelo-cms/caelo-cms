// SPDX-License-Identifier: MPL-2.0

/**
 * #1269 — which pages a plugin's kept link-resolve answers must be asked
 * about again, from the change journal between the mark the answers were
 * read at and now.
 *
 * A plugin that declares `linkResolveReads.pageColumns` says: a row of
 * this table answers for the page its column names, and for no other. A
 * journaled change to such a row then re-asks only that page: the one the
 * row names now (its live row) and every one it named before (its
 * snapshot states — every write of an op records one, on main and on a
 * branch). That is a superset of the pages whose answer can have changed,
 * and asking a page again costs only its own answer.
 *
 * Everything this cannot narrow asks again from scratch, as before: a
 * change to a table without a page column (international-site's locale
 * registry moves every page), a deleted live row or one whose page column
 * changed (a write outside the ops may have left no snapshot of where it
 * was), a Stage / undo / takeover (a snapshot header changed), a truncate,
 * more journal rows than one read, a reader older than the kept answers,
 * and a reader that wrote rows itself.
 *
 * Without it every preview after a variant was written asked about every
 * page of the site, and international-site read its whole variant table
 * for each: on the 50k-page scale gate, where 20 agents create variants,
 * that was the heaviest load of the run (1140 reads, 464 s).
 */

import {
  type DatabaseAdapter,
  defineOperation,
  execute,
  type JournalFilter,
  type OperationDefinition,
  type OperationRegistry,
  readChanges,
  snapshotFollows,
  type TransactionRunner,
  uuidArray,
} from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { hostSystemActorId } from "./dispatch.js";
import { withPluginScope } from "./row-snapshots.js";

/** Most journal rows one delta reads; past it the answers are asked again from scratch. */
export const MAX_LINK_RESOLVE_DELTA = 500;

const IDENT = /^[a-z][a-z0-9_]{0,62}$/;

/** What {@link readLinkResolveDelta} answers: the pages to ask again, or why all of them. */
export type LinkResolveDelta = { readonly pages: readonly string[] } | { readonly whole: string };

const deltaInput = z
  .object({
    pluginId: z.string().uuid(),
    schema: z.string().regex(/^plugin_[a-z][a-z0-9_]*$/),
    pageColumns: z.record(z.string().regex(IDENT), z.string().regex(IDENT)),
    from: z.object({ snapshot: z.string().min(1).max(100_000), ownXid: z.string().nullable() }),
    to: z.object({ snapshot: z.string().min(1).max(100_000), dirty: z.boolean() }),
    // The filter the kept answers were checked with (validated there).
    filter: z.custom<JournalFilter>((v) => typeof v === "object" && v !== null),
  })
  .strict();

const deltaOp = defineOperation({
  name: "plugin_changes.link_resolve_delta",
  // Why human-only: only the host carries the answers it keeps for plugins forward.
  actorScope: ["system"],
  readScope: "request",
  database: "cms_admin",
  input: deltaInput,
  output: z.custom<LinkResolveDelta>(),
  handler: async (_ctx, input, tx) => ok(await deltaOf(tx, input)),
});

async function deltaOf(
  tx: TransactionRunner,
  input: z.infer<typeof deltaInput>,
): Promise<LinkResolveDelta> {
  const { pluginId, schema, pageColumns, from, to, filter } = input;
  if (to.dirty) return { whole: "the reader already wrote rows the answers read" };
  if (!snapshotFollows(from.snapshot, to.snapshot)) {
    return { whole: "the reader's snapshot is older than the kept answers" };
  }
  const read = await readChanges(tx, {
    cursor: from.snapshot,
    target: to.snapshot,
    after: null,
    filter,
    limit: MAX_LINK_RESOLVE_DELTA,
    ownXid: from.ownXid,
  });
  if (read.needsRebuild) return { whole: "the journal no longer holds every change since" };
  if (read.more) return { whole: `more than ${MAX_LINK_RESOLVE_DELTA} journal rows since` };

  const rowsByTable = new Map<string, Set<string>>();
  for (const c of read.changes) {
    if (c.op === "truncate") return { whole: `a truncate of ${c.table}` };
    let table: string;
    if (c.kind === "plugin_storage") {
      table = c.table.split(".")[1] ?? c.table;
      const column = pageColumns[table];
      if (column === undefined) return { whole: `a change of ${table}, which names no page` };
      if (c.op === "delete") return { whole: `a deleted ${table} row` };
      if (c.op === "update" && (c.changedColumns === null || c.changedColumns.includes(column))) {
        return { whole: `a ${table} row whose ${column} changed` };
      }
    } else if (c.kind === "plugin_row") {
      table = c.parentId ?? "";
      if (pageColumns[table] === undefined) {
        return { whole: `a pending change of ${table || "a table"}, which names no page` };
      }
      if (c.op !== "insert") return { whole: `a pending ${table} row was ${c.op}d` };
    } else {
      return { whole: `a ${c.kind} change (a Stage, an undo or a takeover)` };
    }
    const rows = rowsByTable.get(table) ?? new Set<string>();
    rows.add(c.rowId);
    rowsByTable.set(table, rows);
  }

  const pages = new Set<string>();
  for (const [table, rowIds] of rowsByTable) {
    const column = pageColumns[table] as string;
    const ids = uuidArray([...rowIds]);
    // The plugin's tables are RLS-scoped to it: without its scope the live
    // half reads nothing, and a row written outside the ops (no snapshot)
    // would name no page.
    const named = (await withPluginScope(tx, pluginId, () =>
      tx.execute(sql`
      SELECT t.${sql.identifier(column)}::text AS page_id
        FROM ${sql.identifier(schema)}.${sql.identifier(table)} t
       WHERE t.id = ANY(${ids})
      UNION
      SELECT s.state -> 'values' ->> ${column}
        FROM plugin_row_snapshots s
       WHERE s.plugin_id = ${pluginId}::uuid AND s.table_name = ${table} AND s.row_id = ANY(${ids})
    `),
    )) as unknown as { page_id: string | null }[];
    for (const r of named) if (r.page_id) pages.add(r.page_id);
  }
  return { pages: [...pages] };
}

/**
 * The pages whose kept answers changed between `from` and `to`, or why
 * the plugin must be asked about every page again (see the file header).
 */
export async function readLinkResolveDelta(
  adapter: DatabaseAdapter,
  registry: OperationRegistry,
  input: {
    readonly pluginId: string;
    readonly schema: string;
    readonly pageColumns: Readonly<Record<string, string>>;
    readonly from: { readonly snapshot: string; readonly ownXid: string | null };
    readonly to: { readonly snapshot: string; readonly dirty: boolean };
    readonly filter: JournalFilter;
  },
): Promise<LinkResolveDelta> {
  if (!registry.has(deltaOp.name)) {
    registry.register(deltaOp as OperationDefinition<unknown, unknown>);
  }
  const ctx: ExecutionContext = {
    actorId: hostSystemActorId(),
    actorKind: "system",
    requestId: "link-resolve-delta",
  };
  const r = await execute(registry, adapter, ctx, deltaOp.name, {
    pluginId: input.pluginId,
    schema: input.schema,
    pageColumns: input.pageColumns,
    from: { snapshot: input.from.snapshot, ownXid: input.from.ownXid },
    to: { snapshot: input.to.snapshot, dirty: input.to.dirty },
    filter: input.filter,
  });
  if (!r.ok) {
    throw new Error(
      `${deltaOp.name}: ${"message" in r.error ? String(r.error.message) : r.error.kind}`,
    );
  }
  return r.value as LinkResolveDelta;
}
