// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 (decision Q7 A) — URL slots declared as data (`urlTables`,
 * docs/dev/external-plugin-brokers.md §6.8).
 *
 * Core composes a page's path inside the write transactions that change
 * it, and no sandboxed plugin code can run there (#1254). So a plugin that
 * shapes page addresses without in-process code declares two tables of its
 * own private storage, and the HOST reads them while it composes:
 *
 * - `pages`: one row per page that leaves the default shape — its
 *   `page_id` and the value that names its URL space (a market, a
 *   language, a brand). A page without a row composes as if the plugin
 *   were not there, so activating the plugin moves no address.
 * - `values`: one row per value — what it puts into the address: a path
 *   segment in front of the page's path (`path-prefix`), a host of this
 *   install (`host`), or both. A null segment or host is the site's own
 *   shape.
 *
 * Only `host` and `path-prefix` can be data. `slug-format` and `full-path`
 * map every slug through code and stay with in-process plugins: what a
 * runtime-installed plugin may declare is {@link EXTERNAL_URL_SLOTS}.
 *
 * The tables shape every page's address, so they change only in an
 * Owner-approved call (the host handle refuses any other write), and a
 * change moves existing pages only through `propose_url_migration`, with
 * its 301s. Checked for every plugin that declares them, shipped or not.
 */

import { z } from "zod";
import type { PluginIndexes } from "./indexes.js";
import { normalizePluginIndexes } from "./indexes.js";

const ident = z.string().regex(/^[a-z_][a-z0-9_]*$/);

/** The manifest field `urlTables` (see the module comment). */
export const pluginUrlTables = z
  .object({
    /** One row per page: `page_id` (uuid) and the value column. */
    pages: z.object({ table: ident, valueColumn: ident }).strict(),
    /** One row per value: what it puts into the address. */
    values: z
      .object({
        table: ident,
        valueColumn: ident,
        /** The value's path segment (`path-prefix`); null = no prefix. */
        segmentColumn: ident.optional(),
        /** The value's host (`host`); null = the site's own host. */
        hostColumn: ident.optional(),
      })
      .strict()
      .refine((v) => v.segmentColumn !== undefined || v.hostColumn !== undefined, {
        message: "declare segmentColumn (path-prefix), hostColumn (host) or both",
      }),
  })
  .strict();

/** A plugin's declared URL tables. */
export type PluginUrlTables = z.infer<typeof pluginUrlTables>;

/** The URL slots a runtime-installed plugin may claim: the ones data can describe. */
export const EXTERNAL_URL_SLOTS = ["host", "path-prefix"] as const;

/** The most values a plugin's `values` table may hold; the host reads it whole. */
export const URL_TABLE_MAX_VALUES = 500;

/**
 * Segments a value may not put in front of a page's path: the site's own
 * services answer under them (`/api/*` is the gateway). Everything starting
 * with `_` or `.` (`/_caelo`, `/_assets`, `/.well-known`) is already
 * refused by the segment's slug shape.
 */
export const RESERVED_URL_SEGMENTS: ReadonlySet<string> = new Set(["api"]);

/** The slots a declaration fills, in grammar order. */
export function urlTableSlots(tables: PluginUrlTables): Array<"host" | "path-prefix"> {
  return [
    ...(tables.values.hostColumn !== undefined ? (["host"] as const) : []),
    ...(tables.values.segmentColumn !== undefined ? (["path-prefix"] as const) : []),
  ];
}

/**
 * The refusal for a URL slot a runtime-installed plugin cannot claim, or for
 * a claim it makes without declaring its tables, worded for the AI that
 * submitted it. Null when the claim is one it may make.
 */
export function externalUrlSlotRefusal(slot: string, declaresTables: boolean): string | null {
  if ((EXTERNAL_URL_SLOTS as readonly string[]).includes(slot)) {
    return declaresTables
      ? null
      : `URL slot "${slot}" of a runtime-installed plugin is data the host reads, not code: declare \`urlTables\` (a \`pages\` table with page_id and a value, a \`values\` table with the value's ${slot === "host" ? "hostColumn" : "segmentColumn"}) in adminSchema.`;
  }
  return `URL slot "${slot}" is not available to runtime-installed plugins: it maps every page's slug through code, and no plugin code runs while core composes addresses (#1729). Runtime-installed plugins may claim ${EXTERNAL_URL_SLOTS.join(" and ")}, declared as tables (\`urlTables\`). Remove "${slot}" from \`urlContributions\`.`;
}

/**
 * What is wrong with a plugin's `urlTables` against its own declarations,
 * as messages naming the fix: the tables and columns must exist in
 * `adminSchema` with the right types, `urlContributions` must claim
 * exactly the slots the tables fill, and the reads the host makes must
 * have an index each (a page's row by `page_id`, the pages of a value by
 * its value column). Empty when the declaration is sound.
 */
export function urlTablesProblems(m: {
  readonly urlTables?: PluginUrlTables;
  readonly urlContributions?: ReadonlyArray<{ readonly slot: string }>;
  readonly adminSchema?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly indexes?: PluginIndexes;
}): string[] {
  const t = m.urlTables;
  if (!t) return [];
  const problems: string[] = [];
  const admin = m.adminSchema ?? {};
  const column = (table: string, col: string, types: readonly string[], role: string) => {
    const cols = admin[table];
    if (!cols) {
      problems.push(`urlTables: table "${table}" (${role}) is not declared in adminSchema`);
      return;
    }
    const declared = cols[col];
    if (declared === undefined || !types.includes(declared))
      problems.push(
        `urlTables: ${table}.${col} (${role}) must be declared as ${types.map((x) => `"${x}"`).join(" or ")} in adminSchema (it is ${declared === undefined ? "missing" : `"${declared}"`})`,
      );
  };
  const text = ["text", "string"] as const;
  column(t.pages.table, "page_id", ["uuid"], "the page a row shapes");
  column(t.pages.table, t.pages.valueColumn, text, "the page's value");
  column(t.values.table, t.values.valueColumn, text, "the value");
  if (t.values.segmentColumn)
    column(t.values.table, t.values.segmentColumn, text, "the value's path segment");
  if (t.values.hostColumn) column(t.values.table, t.values.hostColumn, text, "the value's host");
  if (t.pages.table === t.values.table)
    problems.push("urlTables: pages and values must be two tables");
  const leads = new Set(
    normalizePluginIndexes(m.indexes?.adminSchema?.[t.pages.table]).map((i) => i.columns[0]),
  );
  for (const col of ["page_id", t.pages.valueColumn]) {
    if (!leads.has(col))
      problems.push(
        `urlTables: the host reads ${t.pages.table} by ${col}; declare an index that starts with it — indexes: { adminSchema: { ${t.pages.table}: [["${col}"]] } }`,
      );
  }
  const claimed = [...new Set((m.urlContributions ?? []).map((c) => c.slot))].sort();
  const filled = urlTableSlots(t).sort();
  if (claimed.join(",") !== filled.join(","))
    problems.push(
      `urlTables fills the URL slots ${filled.join(", ")}; urlContributions must claim exactly those (it claims ${claimed.join(", ") || "none"})`,
    );
  return problems;
}
