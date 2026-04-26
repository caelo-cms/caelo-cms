// SPDX-License-Identifier: MPL-2.0

/**
 * Tiny composition helpers for the Query API ops. After three copies of
 * "build a SET clause from defined-only fields" and "build a WHERE clause
 * from a list of optional filters" the right thing was to extract them.
 *
 * Both return drizzle `SQL` fragments — values flow through the same tagged-
 * template parameteriser handlers already use, so injection-safety is
 * unchanged.
 *
 * Why functions, not a query builder: the rest of the codebase intentionally
 * stays close to raw `sql\`…\``; a 30-line helper preserves that style and
 * stays easy to grep. Bringing in a builder would weaken the audit-by-grep
 * property the Query API relies on.
 */

import { type SQL, sql } from "drizzle-orm";

export type Patch = Record<string, unknown>;

/**
 * Builds a comma-joined SET-clause fragment from `patch`, including only
 * keys whose value is not `undefined`. Always appends `updated_at = now()`
 * so callers do not need to remember it. Throws if no field would be set
 * (an empty UPDATE wastes a round-trip and almost always indicates a bug
 * in the caller's optional-field logic).
 *
 * Example:
 *   buildPatchSet({ display_name: input.displayName, html: input.html })
 *   → SET display_name = $1, html = $2, updated_at = now()
 */
export function buildPatchSet(patch: Patch): SQL {
  const parts: SQL[] = [];
  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    parts.push(sql.raw(`${column} = `).append(sql`${value}`));
  }
  if (parts.length === 0) {
    throw new Error("buildPatchSet: at least one field must be set");
  }
  parts.push(sql`updated_at = now()`);
  return sql.join(parts, sql`, `);
}

/**
 * Builds a `WHERE …` fragment from a list of `SQL` predicates joined with
 * AND. Returns an empty fragment when the list is empty (so the caller can
 * always interpolate it unconditionally).
 *
 * Example:
 *   const filters = [];
 *   if (!opts.includeDeleted) filters.push(sql`deleted_at IS NULL`);
 *   if (opts.locale) filters.push(sql`locale = ${opts.locale}`);
 *   sql`SELECT … FROM pages ${buildWhere(filters)} ORDER BY …`
 */
export function buildWhere(predicates: readonly SQL[]): SQL {
  if (predicates.length === 0) return sql``;
  // sql.join wants a mutable SQLChunk[] — copy so callers can pass a literal
  // typed as readonly without a cast.
  return sql`WHERE ${sql.join([...predicates], sql` AND `)}`;
}
