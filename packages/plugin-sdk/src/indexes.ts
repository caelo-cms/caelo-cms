// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin table indexes (#1292).
 *
 * A plugin's tables get their primary key from the host and nothing else
 * unless the manifest asks: `indexes.schema` (cms_public tables) and
 * `indexes.adminSchema` (private storage in cms_admin) map a table to the
 * column lists the plugin reads by. The host emits them on every load of
 * the plugin and drops the ones a new version no longer declares, so an
 * installed site gets a version's indexes the moment that version loads.
 *
 * The host indexes some columns on its own, with no declaration:
 *   - `id` (the primary key) in both zones;
 *   - every `ref:` column of `adminSchema` (a core delete cascades by it);
 *   - the host column `caelo_chat_branch_id` (a chat's publish and
 *     discard find the chat's rows by it).
 *
 * A read is only served when an index can drive it, so no plugin read
 * becomes a full table scan as its table grows:
 *   - a `list()` that filters (`{column: value}`, `anyOf`) is refused
 *     unless one of its filter columns is the FIRST column of a declared
 *     or automatic index (ordering by an indexed column does not count: it
 *     would walk the whole index and test every row);
 *   - an unfiltered `list()` that orders (`orderBy`) or takes a
 *     `since`/`before` range (on `created_at`) needs one of those columns
 *     to lead an index — `orderBy: "id"` (the keyset `afterId` pages by)
 *     always does;
 *   - a read with only a `limit` stays allowed: it stops after `limit` rows.
 * Put the filter columns first and the order column last
 * (`["status", "created_at"]`) and one index serves filter and order.
 *
 * @example
 * ```ts
 * definePlugin({
 *   slug: "reviews", version: "1.1.0", tier: 2,
 *   schema: {
 *     reviews: { page_id: "uuid", status: "enum:pending,approved", stars: "int", created_at: "timestamp" },
 *   },
 *   indexes: {
 *     schema: {
 *       // list("reviews", { page_id, status: "approved", orderBy: "created_at" })
 *       reviews: [["page_id", "status", "created_at"], ["status", "created_at"]],
 *     },
 *   },
 *   operations: { ... },
 * });
 * ```
 */

import { z } from "zod";

/** Most indexes one table may declare. */
export const PLUGIN_INDEXES_MAX_PER_TABLE = 16;
/** Most columns one index may span. */
export const PLUGIN_INDEX_MAX_COLUMNS = 4;

const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const indexColumns = z.array(identifier).min(1).max(PLUGIN_INDEX_MAX_COLUMNS);

/**
 * One index: its columns in order (`["group_id", "translation_status"]`),
 * or `{ columns, unique: true }` for a unique one (cms_public `schema`
 * only — see {@link checkPluginIndexes}), or `{ columns: [col], method:
 * "hash" }` for an equality-only lookup on a value of unbounded length
 * (a btree entry holds at most ~2.7 KB, so a longer stored value fails
 * the build; a hash index stores the value's hash and serves `=` and
 * `anyOf`, never an order).
 */
export const pluginIndexSpec = z.union([
  indexColumns,
  z
    .object({
      columns: indexColumns,
      unique: z.boolean().optional(),
      method: z.enum(["btree", "hash"]).optional(),
    })
    .strict(),
]);

export type PluginIndexSpec = z.infer<typeof pluginIndexSpec>;

/** Table → the indexes it declares. */
export const pluginIndexMap = z.record(
  identifier,
  z.array(pluginIndexSpec).min(1).max(PLUGIN_INDEXES_MAX_PER_TABLE),
);

export type PluginIndexMap = z.infer<typeof pluginIndexMap>;

/** The manifest's `indexes`: one map per storage zone. */
export const pluginIndexes = z
  .object({ schema: pluginIndexMap.optional(), adminSchema: pluginIndexMap.optional() })
  .strict();

export type PluginIndexes = z.infer<typeof pluginIndexes>;

/** An index with its shorthand resolved. */
export interface NormalizedPluginIndex {
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly method: "btree" | "hash";
}

/** Resolve the `string[]` shorthand; order is kept. */
export function normalizePluginIndexes(
  specs: ReadonlyArray<PluginIndexSpec> | undefined,
): NormalizedPluginIndex[] {
  return (specs ?? []).map((s) =>
    Array.isArray(s)
      ? { columns: [...s], unique: false, method: "btree" }
      : { columns: [...s.columns], unique: s.unique === true, method: s.method ?? "btree" },
  );
}

/** The storage zone a table lives in: `schema` (cms_public) or `adminSchema` (private). */
export type PluginStorageZone = "schema" | "adminSchema";

/**
 * Columns the host indexes on its own, as one-column indexes: in private
 * storage every `ref:` column. (`id` is the primary key in both zones.)
 */
export function automaticIndexColumns(
  zone: PluginStorageZone,
  columns: Readonly<Record<string, string>>,
): string[] {
  if (zone !== "adminSchema") return [];
  return Object.entries(columns)
    .filter(([, spec]) => spec.startsWith("ref:"))
    .map(([name]) => name);
}

/**
 * Check `indexes` against the tables it indexes. Reported per index, with
 * the reason and what to write instead.
 */
export function checkPluginIndexes(
  m: {
    readonly schema: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly adminSchema?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly indexes?: PluginIndexes;
  },
  addIssue: (path: (string | number)[], message: string) => void,
): void {
  for (const zone of ["schema", "adminSchema"] as const) {
    const tables = zone === "schema" ? m.schema : (m.adminSchema ?? {});
    for (const [table, specs] of Object.entries(m.indexes?.[zone] ?? {})) {
      const columns = tables[table];
      if (!columns) {
        addIssue(
          [zone, table],
          `indexes.${zone} names table "${table}", which ${zone} does not declare`,
        );
        continue;
      }
      const automatic = new Set(automaticIndexColumns(zone, columns));
      const seen = new Set<string>();
      for (const [i, index] of normalizePluginIndexes(specs).entries()) {
        const at = [zone, table, i];
        const problem = indexProblem(zone, table, columns, index, automatic);
        if (problem) addIssue(at, problem);
        const key = `${index.method}:${index.columns.join(",")}`;
        if (seen.has(key)) {
          addIssue(at, `indexes.${zone}.${table}: (${key}) is declared twice`);
        }
        seen.add(key);
      }
    }
  }
}

function indexProblem(
  zone: PluginStorageZone,
  table: string,
  columns: Readonly<Record<string, string>>,
  index: NormalizedPluginIndex,
  automatic: ReadonlySet<string>,
): string | null {
  const where = `indexes.${zone}.${table}`;
  const names = new Set<string>();
  for (const [i, column] of index.columns.entries()) {
    if (column.startsWith("caelo_")) {
      return `${where}: "${column}" is a host-owned column; the host indexes the ones it filters by itself`;
    }
    if (column === "id") {
      if (i === 0) {
        return `${where}: "id" is the primary key and already indexed — put it after the column you filter by (e.g. ["status", "id"]) or drop the index`;
      }
    } else if (!(column in columns)) {
      return `${where}: column "${column}" is not declared on ${zone}.${table}`;
    } else if (columns[column] === "jsonb") {
      return `${where}: "${column}" is jsonb, which cannot be indexed — keep the value you read by in its own string/uuid/int column`;
    }
    if (names.has(column)) return `${where}: column "${column}" appears twice in one index`;
    names.add(column);
  }
  if (index.method === "hash" && (index.columns.length !== 1 || index.unique)) {
    return `${where}: a hash index covers exactly one column and cannot be unique — use a btree index (the default) for several columns or uniqueness`;
  }
  if (index.unique && zone === "adminSchema") {
    return `${where}: unique indexes are only available in indexes.schema (cms_public). A private-storage row can change on a chat branch, which no index sees until publish — check uniqueness in the operation instead (list by the column, then insert)`;
  }
  const only = index.columns.length === 1 ? index.columns[0] : undefined;
  if (only !== undefined && automatic.has(only)) {
    return `${where}: "${only}" is a ref: column, which the host already indexes — drop this index`;
  }
  return null;
}
