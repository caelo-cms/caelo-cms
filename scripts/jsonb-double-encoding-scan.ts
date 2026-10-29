// SPDX-License-Identifier: MPL-2.0

/**
 * Finds jsonb values stored double-encoded (#68): a jsonb STRING scalar
 * whose text is itself a JSON object or array.
 *
 * bun:SQL binds a JS string under a `::jsonb` cast — explicit, or implicit
 * through the column type (`INSERT … VALUES (${JSON.stringify(x)})`) — as
 * a jsonb string, so `JSON.stringify` before a jsonb write stores
 * `"{\"a\":1}"` instead of `{"a":1}`. The source lint
 * (`jsonb-encoding.static.test.ts`) catches the explicit `}::jsonb` form;
 * this scan catches every form by looking at what was actually stored.
 * The test preload runs it after every integration file, so any write path
 * a test exercises that double-encodes fails that file.
 */

import type { SQL } from "bun";

/** One column holding double-encoded values, with a sample to locate the writer. */
export interface DoubleEncodedColumn {
  readonly column: string;
  readonly sample: string;
}

/** Leading text of a stored string scalar that might be JSON (`{` or `[`). */
const JSONISH = "^\\s*[\\[{]";

/**
 * Scans every jsonb column of the base tables in `public` of the database
 * `sql` is connected to.
 *
 * @returns the columns holding at least one string scalar that parses as a
 *   JSON object or array (empty when the data is clean).
 */
export async function findDoubleEncodedJsonb(sql: SQL): Promise<DoubleEncodedColumn[]> {
  return await sql.begin(async (tx) => {
    // RLS admits reads only with an actor kind set (CLAUDE.md §2).
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    const columns = (await tx`
      SELECT c.table_name AS t, c.column_name AS c
        FROM information_schema.columns c
        JOIN information_schema.tables tb USING (table_schema, table_name)
       WHERE c.table_schema = 'public' AND c.data_type = 'jsonb' AND tb.table_type = 'BASE TABLE'
       ORDER BY 1, 2
    `) as { t: string; c: string }[];
    if (columns.length === 0) return [];
    const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
    const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
    const union = columns
      .map(
        ({ t, c }) =>
          `(SELECT ${literal(`${t}.${c}`)} AS col, (${ident(c)} #>> '{}') AS s FROM ${ident(t)}
             WHERE jsonb_typeof(${ident(c)}) = 'string' AND (${ident(c)} #>> '{}') ~ '${JSONISH}'
             LIMIT 3)`,
      )
      .join(" UNION ALL ");
    const rows = (await tx.unsafe(union)) as { col: string; s: string }[];
    const out = new Map<string, DoubleEncodedColumn>();
    for (const r of rows) {
      if (out.has(r.col) || !parsesToStructure(r.s)) continue;
      out.set(r.col, { column: r.col, sample: r.s.slice(0, 120) });
    }
    return [...out.values()];
  });
}

function parsesToStructure(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}
