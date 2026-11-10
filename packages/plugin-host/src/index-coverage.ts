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

import {
  type IndexLeads,
  type ListIndexAccess,
  listIndexRefusal,
  readsByColumn,
} from "@caelo-cms/plugin-sdk";
import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { ListPlan } from "./private-storage.js";

// The rule itself is the SDK's, so a plugin's unit tests apply exactly
// what this host applies (`indexCheckedQuery`, #1536).
export { type IndexLeads, type ListIndexAccess, listIndexRefusal, readsByColumn };

/** The columns a parsed `list` filter reads by (the SDK's `listAccessOfFilter` on the raw filter). */
export function listAccessOf(plan: ListPlan): ListIndexAccess {
  return {
    equals: plan.equals.map(([k]) => k),
    isNull: plan.equals.filter(([, v]) => v === null).map(([k]) => k),
    anyOf: plan.anyOf.map(([k]) => k),
    orderBy: plan.orderBy,
    createdAtRange: plan.since !== null || plan.before !== null,
  };
}

/**
 * The first column of every valid index on `schema.table`, read from the
 * catalog in the caller's transaction, split by whether the index can
 * return rows in order (btree) or only find equal values (hash).
 * Identifiers are checked by the caller (storage-ops validates both
 * against its identifier pattern).
 */
export async function indexLeadColumns(
  tx: TransactionRunner,
  schema: string,
  table: string,
): Promise<IndexLeads> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT a.attname::text AS col, am.amname = 'btree' AS ordered
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid = c.relam
    JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = to_regclass(${`"${schema}"."${table}"`}) AND i.indisvalid
  `)) as unknown as { col: string; ordered: boolean }[];
  return {
    any: new Set(rows.map((r) => r.col)),
    ordered: new Set(rows.filter((r) => r.ordered).map((r) => r.col)),
  };
}
