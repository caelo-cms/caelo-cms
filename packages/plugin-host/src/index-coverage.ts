// SPDX-License-Identifier: MPL-2.0

/**
 * #1292 — may a plugin `list()` run, given the table's indexes?
 *
 * The rule (docs/plugin-indexes.md): a filtered read must be driven by one
 * of its filter columns, an unfiltered ordered or `since`/`before` read by
 * its order column or `created_at`; a read with only a `limit` is free. A
 * column drives a read when it is the first column of an index the table
 * has.
 *
 * The indexes come from the database catalog, not from the caller: the
 * storage operations are reachable from plugin code (`ctx.cms.call`), so a
 * caller-supplied index list could claim indexes that do not exist. The
 * catalog holds exactly what the emitters built from the manifest
 * (`indexes`, plus the primary key, the `ref:` columns and the branch
 * column), so it is the declaration as provisioned.
 */

import type { PluginStorageZone } from "@caelo-cms/plugin-sdk";
import { PLUGIN_INDEX_MAX_COLUMNS } from "@caelo-cms/plugin-sdk";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { ListPlan } from "./private-storage.js";

/** The columns one `list()` reads by, as the host parsed its filter. */
export interface ListIndexAccess {
  readonly equals: ReadonlyArray<string>;
  readonly anyOf: ReadonlyArray<string>;
  readonly orderBy: string | null;
  /** `since` or `before` — both range over `created_at`. */
  readonly createdAtRange: boolean;
}

/** The columns a parsed `list` filter reads by. */
export function listAccessOf(plan: ListPlan): ListIndexAccess {
  return {
    equals: plan.equals.map(([k]) => k),
    anyOf: plan.anyOf.map(([k]) => k),
    orderBy: plan.orderBy,
    createdAtRange: plan.since !== null || plan.before !== null,
  };
}

/** Does the read filter, order or range at all? (A `limit`-only read needs no index.) */
export function readsByColumn(access: ListIndexAccess): boolean {
  return (
    access.equals.length > 0 ||
    access.anyOf.length > 0 ||
    access.orderBy !== null ||
    access.createdAtRange
  );
}

/**
 * The first column of every valid index on `schema.table`, read from the
 * catalog in the caller's transaction. Identifiers are checked by the
 * caller (storage-ops validates both against its identifier pattern).
 */
export async function indexLeadColumns(
  tx: TransactionRunner,
  schema: string,
  table: string,
): Promise<Set<string>> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT a.attname::text AS col
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = to_regclass(${`"${schema}"."${table}"`}) AND i.indisvalid
  `)) as unknown as { col: string }[];
  return new Set(rows.map((r) => r.col));
}

/**
 * Why no index can drive this read, or null when one can. The message
 * names the index to declare and where.
 *
 * @param label error prefix, e.g. `plugin_storage.list`
 * @param leads the first columns of the table's indexes ({@link indexLeadColumns})
 */
export function listIndexRefusal(args: {
  readonly label: string;
  readonly zone: PluginStorageZone;
  readonly table: string;
  readonly leads: ReadonlySet<string>;
  readonly access: ListIndexAccess;
}): string | null {
  const { access } = args;
  const filtered = [...new Set([...access.equals, ...access.anyOf])];
  const ordered = [
    ...(access.createdAtRange ? ["created_at"] : []),
    ...(access.orderBy !== null ? [access.orderBy] : []),
  ].filter((c, i, all) => !filtered.includes(c) && all.indexOf(c) === i);
  // A filtered read must be driven by a filter column: ordering by an
  // indexed column (say `id`, to page) would still walk the whole index
  // and test every row. Only an unfiltered read is driven by its order.
  const driving = filtered.length > 0 ? filtered : ordered;
  if (driving.length === 0) return null;
  if (driving.some((c) => args.leads.has(c))) return null;
  const suggestion = [...filtered, ...ordered].slice(0, PLUGIN_INDEX_MAX_COLUMNS);
  return (
    `${args.label}: no index covers this read of "${args.table}" (it ${filtered.length > 0 ? "filters" : "orders"} by ${driving.join(", ")}). ` +
    `Declare one in the plugin's manifest — indexes: { ${args.zone}: { ${args.table}: [${JSON.stringify(suggestion)}] } } — ` +
    "and ship it as a new version. A filtered read needs an index whose first column is one of its filter columns; an unfiltered ordered or since/before read one led by its order column (created_at for since/before). id" +
    (args.zone === "adminSchema" ? " and ref: columns are" : " is") +
    " indexed automatically."
  );
}
