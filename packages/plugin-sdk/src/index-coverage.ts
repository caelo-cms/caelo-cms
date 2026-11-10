// SPDX-License-Identifier: MPL-2.0

/**
 * #1292 — the read rule: may a plugin `list()` run, given the table's
 * indexes? (docs/plugin-indexes.md)
 *
 * A filtered read must be driven by one of its filter columns, an
 * unfiltered ordered or `since`/`before` read by its order column or
 * `created_at`; a read with only a `limit` is free. A column drives a read
 * when it is the first column of an index the table has.
 *
 * The rule lives in the SDK because two places apply it and must agree:
 * the host's storage operations (`plugin-host/src/index-coverage.ts`,
 * which reads the indexes from the database catalog), and a plugin's own
 * unit tests ({@link indexCheckedQuery}, which derives them from the
 * manifest the way the emitters build them). #1536 shipped a read the
 * host refuses because the plugin's tests faked `list()` without the
 * rule; a fake that applies it fails the same way the host does.
 */

import {
  automaticIndexColumns,
  normalizePluginIndexes,
  PLUGIN_INDEX_MAX_COLUMNS,
  type PluginIndexes,
  type PluginStorageZone,
} from "./indexes.js";

/** The columns one `list()` reads by. */
export interface ListIndexAccess {
  readonly equals: ReadonlyArray<string>;
  /**
   * The `equals` columns compared with `null` — an `IS NULL`, which a
   * hash index cannot answer (it only supports `=`). Omitted: none.
   */
  readonly isNull?: ReadonlyArray<string>;
  readonly anyOf: ReadonlyArray<string>;
  readonly orderBy: string | null;
  /** `since` or `before` — both range over `created_at`. */
  readonly createdAtRange: boolean;
}

/** Filter keys that are not column filters (`PluginQueryFilter`). */
const FILTER_OPTIONS = new Set([
  "limit",
  "orderBy",
  "orderDir",
  "anyOf",
  "afterId",
  "since",
  "before",
]);

/**
 * The columns a `list()` filter reads by, from the filter as a plugin
 * passes it. The host derives the same from its parsed filter
 * (`listAccessOf`); a host test pins that both agree.
 */
export function listAccessOfFilter(filter: Readonly<Record<string, unknown>>): ListIndexAccess {
  const equals = Object.keys(filter).filter((k) => !FILTER_OPTIONS.has(k));
  const anyOf = filter.anyOf;
  return {
    equals,
    isNull: equals.filter((k) => filter[k] === null),
    anyOf: anyOf !== null && typeof anyOf === "object" ? Object.keys(anyOf) : [],
    orderBy: typeof filter.orderBy === "string" ? filter.orderBy : null,
    createdAtRange: filter.since !== undefined || filter.before !== undefined,
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

/** The first columns of a table's indexes: all of them, and the btree ones (which can also deliver an order). */
export interface IndexLeads {
  readonly any: ReadonlySet<string>;
  readonly ordered: ReadonlySet<string>;
}

/**
 * The first columns of the indexes the host builds for one table from the
 * manifest: the primary key `id`, every declared index, and in private
 * storage each `ref:` column and the branch column — the set the
 * database catalog holds after provisioning (`emitIndexes`,
 * `plugin-sandbox/src/schema.ts`).
 */
export function declaredIndexLeads(args: {
  readonly zone: PluginStorageZone;
  readonly columns: Readonly<Record<string, string>>;
  readonly indexes: PluginIndexes | undefined;
  readonly table: string;
}): IndexLeads {
  const any = new Set<string>(["id"]);
  const ordered = new Set<string>(["id"]);
  for (const index of normalizePluginIndexes(args.indexes?.[args.zone]?.[args.table])) {
    const lead = index.columns[0];
    if (lead === undefined) continue;
    any.add(lead);
    if (index.method === "btree") ordered.add(lead);
  }
  const automatic = [
    ...automaticIndexColumns(args.zone, args.columns),
    ...(args.zone === "adminSchema" ? ["caelo_chat_branch_id"] : []),
  ];
  for (const c of automatic) {
    any.add(c);
    ordered.add(c);
  }
  return { any, ordered };
}

/**
 * Why no index can drive this read, or null when one can. The message
 * names the index to declare and where.
 *
 * @param label error prefix, e.g. `plugin_storage.list`
 * @param leads the first columns of the table's indexes; a filter may be
 *   driven by any index, an order only by a btree one
 */
export function listIndexRefusal(args: {
  readonly label: string;
  readonly zone: PluginStorageZone;
  readonly table: string;
  readonly leads: IndexLeads;
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
  // A btree index serves equality, IS NULL and order; a hash index only `=`.
  const isNull = new Set(access.isNull ?? []);
  const usable = (c: string) =>
    filtered.length > 0 && !isNull.has(c) ? args.leads.any.has(c) : args.leads.ordered.has(c);
  if (driving.some(usable)) return null;
  const suggestion = [...filtered, ...ordered].slice(0, PLUGIN_INDEX_MAX_COLUMNS);
  return (
    `${args.label}: no index covers this read of "${args.table}" (it ${filtered.length > 0 ? "filters" : "orders"} by ${driving.join(", ")}). ` +
    `Declare one in the plugin's manifest — indexes: { ${args.zone}: { ${args.table}: [${JSON.stringify(suggestion)}] } } — ` +
    "and ship it as a new version. A filtered read needs an index whose first column is one of its filter columns; an unfiltered ordered or since/before read one led by its order column (created_at for since/before). id" +
    (args.zone === "adminSchema" ? " and ref: columns are" : " is") +
    " indexed automatically."
  );
}

/** The parts of a plugin definition the read rule needs. */
export interface IndexedStorageManifest {
  readonly schema: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly adminSchema?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly indexes?: PluginIndexes;
}

/**
 * For a plugin's unit tests: `inner` (a fake `ctx.query` or
 * `ctx.adminQuery`) with the host's read rule in front of `list()`. A read
 * no index of the manifest can drive throws the message the host's
 * storage operation fails with, so a test that reaches the read fails
 * before the plugin ships (#1536). Other methods pass through.
 *
 * @example
 * ```ts
 * import plugin from "./index.js";
 * const q = indexCheckedQuery(plugin, "adminSchema", { list: async () => rows });
 * ```
 */
export function indexCheckedQuery<Q extends { list: (...args: never[]) => Promise<unknown> }>(
  manifest: IndexedStorageManifest,
  zone: PluginStorageZone,
  inner: Q,
): Q {
  const tables = zone === "schema" ? manifest.schema : (manifest.adminSchema ?? {});
  const label = zone === "schema" ? "plugin_public_storage.list" : "plugin_storage.list";
  const list = async (table: string, filter: Readonly<Record<string, unknown>> = {}) => {
    const columns = tables[table];
    if (!columns) throw new Error(`${label}: table "${table}" is not declared in ${zone}`);
    const access = listAccessOfFilter(filter);
    if (readsByColumn(access)) {
      const refusal = listIndexRefusal({
        label,
        zone,
        table,
        leads: declaredIndexLeads({ zone, columns, indexes: manifest.indexes, table }),
        access,
      });
      if (refusal) throw new Error(refusal);
    }
    return (inner.list as unknown as (t: string, f: unknown) => Promise<unknown>)(table, filter);
  };
  return { ...inner, list } as unknown as Q;
}
