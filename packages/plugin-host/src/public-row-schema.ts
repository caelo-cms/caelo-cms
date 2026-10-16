// SPDX-License-Identifier: MPL-2.0

/**
 * The boundary for plugin data read back from cms_public on the admin side
 * (issue #635, CLAUDE.md §2: public → admin data is untrusted).
 *
 * A plugin's public tables are written by visitors through the gateway —
 * and, if the public side is compromised, by anyone. When the ADMIN's
 * plugin host lists such a table (an Owner panel, a chat tool, a worker),
 * every row is checked against the plugin's own declared column types
 * before the plugin sees it: a `uuid` column holds a UUID, an `int` an
 * integer, an `enum:` one of its values, text stays within a size bound.
 * A row that does not fit is dropped and counted, never coerced — the
 * plugin's code (which casts its rows) then never runs on a shape it did
 * not declare.
 */

import { z } from "zod";

/** Upper bound for one `string` column read back (characters). */
const STRING_MAX = 10_000;
/** Upper bound for one `text` column read back (characters). */
const TEXT_MAX = 1_000_000;

const timestamp = z.union([z.date(), z.string().max(64)]);

function columnSchema(spec: string): z.ZodType {
  if (spec.startsWith("enum:")) {
    const values = spec.slice("enum:".length).split(",");
    return z.enum(values as [string, ...string[]]).nullable();
  }
  if (spec.startsWith("ref:")) return z.string().uuid().nullable();
  switch (spec) {
    case "uuid":
      return z.string().uuid().nullable();
    case "string":
      return z.string().max(STRING_MAX).nullable();
    case "text":
      return z.string().max(TEXT_MAX).nullable();
    case "int":
      return z.number().int().nullable();
    case "bool":
      return z.boolean().nullable();
    case "timestamp":
    case "timestamp_nullable":
      return timestamp.nullable();
    case "jsonb":
      return z.unknown();
    default:
      throw new Error(`public row schema: unknown column type "${spec}"`);
  }
}

const cache = new WeakMap<object, z.ZodType>();

/**
 * The Zod schema of one declared table's rows: its declared columns (plus
 * `id`) with their types; columns not declared are stripped.
 */
export function publicRowSchema(columns: Readonly<Record<string, string>>): z.ZodType {
  const hit = cache.get(columns);
  if (hit) return hit;
  const shape: Record<string, z.ZodType> = { id: z.string().uuid() };
  for (const [name, spec] of Object.entries(columns)) {
    shape[name] = name === "id" ? z.string().uuid() : columnSchema(spec).optional();
  }
  const schema = z.object(shape);
  cache.set(columns, schema);
  return schema;
}

/**
 * Validate rows a plugin listed from its cms_public table on the admin
 * side. Drops and counts the rows that do not match the declaration; logs
 * the count with the plugin and table, never a row's content.
 */
export function validatePublicRows<T>(
  plugin: string,
  table: string,
  columns: Readonly<Record<string, string>>,
  rows: readonly unknown[],
): T[] {
  const schema = publicRowSchema(columns);
  const out: T[] = [];
  let dropped = 0;
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data as T);
    else dropped += 1;
  }
  if (dropped > 0) {
    console.warn(
      `[public-boundary] ${plugin}.${table}: dropped ${dropped} cms_public row(s) that do not match the plugin's declared schema`,
    );
  }
  return out;
}
