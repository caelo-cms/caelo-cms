// SPDX-License-Identifier: MPL-2.0

/**
 * #1213 — complete reads of this plugin's private tables.
 *
 * One store read returns at most 1000 rows. Reading "the first 1000" and
 * planning with them silently drops hreflang, switcher entries and
 * translation state on a large site, and refusing at 1000 rows breaks the
 * site outright (CLAUDE.md §2: no silent truncation, no hidden fallback).
 * So whole-table reads page by id until a short page, and reads for a set
 * of values (page ids, group ids) go out as `anyOf` batches — one read per
 * 1000 values instead of one read per value.
 */

import type { PluginAdminQuery, PluginQueryFilter } from "@caelo-cms/plugin-sdk";

/** The store's per-read ceiling (rows returned, values per `anyOf` column). */
export const STORE_READ_MAX = 1000;

/**
 * Every row of `table` matching `filter`, paged by id. Costs one read per
 * 1000 matching rows.
 */
export async function listAll(
  q: PluginAdminQuery,
  table: string,
  filter: PluginQueryFilter = {},
): Promise<unknown[]> {
  const out: unknown[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = (await q.list(table, {
      ...filter,
      orderBy: "id",
      orderDir: "asc",
      limit: STORE_READ_MAX,
      ...(afterId ? { afterId } : {}),
    })) as { id?: unknown }[];
    out.push(...page);
    if (page.length < STORE_READ_MAX) return out;
    const last = page[page.length - 1]?.id;
    if (typeof last !== "string") {
      throw new Error(`international-site: ${table} returned a row without an id; cannot page on`);
    }
    afterId = last;
  }
}

/**
 * Every row of `table` whose `column` holds one of `values` (and that
 * matches `filter`): one `anyOf` read per 1000 values (each paged in case
 * one value matches many rows). No read at all for an empty list.
 */
export async function listWhereAnyOf(
  q: PluginAdminQuery,
  table: string,
  column: string,
  values: readonly string[],
  filter: PluginQueryFilter = {},
): Promise<unknown[]> {
  const unique = [...new Set(values)];
  const out: unknown[] = [];
  for (let i = 0; i < unique.length; i += STORE_READ_MAX) {
    const chunk = unique.slice(i, i + STORE_READ_MAX);
    out.push(...(await listAll(q, table, { ...filter, anyOf: { [column]: chunk } })));
  }
  return out;
}

/** `ids` in slices the core read ops accept (`pageIds` ≤ 1000). */
export function chunked<T>(ids: readonly T[], size = STORE_READ_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
