// SPDX-License-Identifier: MPL-2.0

/**
 * The schema mapping of a page type (#1756): which schema type its pages
 * are and where each role's value comes from. Stored in the plugin's own
 * table `type_mappings`, one row per page type, branch-aware like every
 * plugin row: a chat's change is draft until a Stage and live with Publish
 * live (CLAUDE.md §2).
 *
 * Why a table of the plugin and not `entityConfig.pageType` (the issue's
 * first idea): a mapping is a record of role → source whose roles depend on
 * the schema type, which config leaves cannot hold, and a plugin cannot
 * write its own config to check a mapping against the page type's
 * properties first. The table gives the AI one write that is checked
 * before it lands, with the same draft semantics.
 */

import { z } from "@caelo-cms/plugin-sdk";
import {
  CORE_SOURCES,
  SCHEMA_TYPE_NAMES,
  SCHEMA_TYPES,
  type SchemaRole,
  type SourceKind,
} from "./types.js";

/** The plugin's table of mappings (its `adminSchema`). */
export const MAPPINGS_TABLE = "type_mappings";

/** One role's source: `prop:<name>` or a core field. */
export const roleSourceSchema = z
  .string()
  .regex(
    /^(?:prop:[a-z][a-z0-9_]{0,63}|title|short_title|description|share_image|organization)$/,
    "a source is `prop:<property name>` or one of title, short_title, description, share_image, organization",
  );

/** One mapping as the AI writes it and the plugin stores it. */
export const schemaMappingSchema = z
  .object({
    pageType: z.string().min(1).max(64),
    /** A schema type of the plugin's table, or `none` to remove the mapping. */
    schemaType: z.string().min(1).max(64),
    roles: z
      .record(
        z.string().min(1).max(64),
        z.union([roleSourceSchema, z.array(roleSourceSchema).min(1).max(10)]),
      )
      .default({}),
  })
  .strict();

/** One mapping. */
export type SchemaMapping = z.infer<typeof schemaMappingSchema>;

/** A stored row of {@link MAPPINGS_TABLE}. */
export interface MappingRow {
  readonly id: string;
  readonly page_type: string;
  readonly schema_type: string;
  readonly roles: unknown;
}

/** One property of a page type, as the mapping checks it. */
export interface PropertyInfo {
  readonly name: string;
  readonly type: string;
  readonly multiple?: boolean;
}

/** The sources of a role as a list. */
export function sourcesOf(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

/** The kind of value a source gives, or null when the page type has no such property. */
function kindOf(source: string, properties: readonly PropertyInfo[]): SourceKind | null {
  if (source.startsWith("prop:")) {
    const p = properties.find((x) => x.name === source.slice(5));
    return p ? (p.type as SourceKind) : null;
  }
  return CORE_SOURCES[source as keyof typeof CORE_SOURCES] ?? null;
}

/** Why one role's sources do not fit, or null. */
function roleProblem(
  role: string,
  spec: SchemaRole,
  value: string | readonly string[],
  properties: readonly PropertyInfo[],
): string | null {
  const sources = sourcesOf(value);
  if (typeof value !== "string" && !spec.multiple) {
    return `role "${role}" takes one source, not a list`;
  }
  for (const source of sources) {
    const kind = kindOf(source, properties);
    if (kind === null) {
      const names = properties.map((p) => `${p.name} (${p.type})`).join(", ") || "none";
      return `role "${role}": the page type has no property "${source.slice(5)}" (its properties: ${names}); add it with upsert_page_types_many first`;
    }
    if (!spec.accepts.includes(kind)) {
      return `role "${role}" takes ${spec.accepts.join(" or ")}, and ${source} is ${kind}`;
    }
  }
  return null;
}

/**
 * What is wrong with a mapping for a page type with these properties, each
 * an AI-actionable sentence; empty when it may be stored.
 */
export function mappingProblems(
  mapping: SchemaMapping,
  properties: readonly PropertyInfo[],
): string[] {
  const spec = SCHEMA_TYPES[mapping.schemaType];
  if (!spec) {
    return [
      `schema type "${mapping.schemaType}" is not one the plugin writes; use one of ${SCHEMA_TYPE_NAMES.join(", ")} (or none to remove the mapping)`,
    ];
  }
  const problems: string[] = [];
  for (const [role, value] of Object.entries(mapping.roles)) {
    const roleSpec = spec.roles[role];
    if (!roleSpec) {
      const known = Object.keys(spec.roles).join(", ") || "none";
      problems.push(`${mapping.schemaType} has no role "${role}" (its roles: ${known})`);
      continue;
    }
    const problem = roleProblem(role, roleSpec, value, properties);
    if (problem) problems.push(problem);
  }
  return problems;
}

/**
 * A stored row as a mapping. Loud (CLAUDE.md §2): a row this version cannot
 * read (a schema type it no longer writes) fails the render with the fix,
 * never renders the page without its structured data.
 */
export function mappingOfRow(row: MappingRow): SchemaMapping {
  const parsed = schemaMappingSchema.safeParse({
    pageType: row.page_type,
    schemaType: row.schema_type,
    roles: typeof row.roles === "string" ? JSON.parse(row.roles) : (row.roles ?? {}),
  });
  if (!parsed.success || !SCHEMA_TYPES[parsed.data.schemaType]) {
    throw new Error(
      `seo: the stored schema mapping of page type "${row.page_type}" (${row.schema_type}) is not one this version writes; set it again with set_schema_mappings_many`,
    );
  }
  return parsed.data;
}
