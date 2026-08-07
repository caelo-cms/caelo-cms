// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-sandbox/schema — schema-from-spec SQL emitter.
 *
 * Translates a plugin's declared `schema` map into CREATE TABLE
 * statements scoped to a slug-prefixed schema in cms_public:
 *
 *   slug = "comments"  →  schema name "plugin_comments"
 *
 * Every emitted table gets:
 *   - id uuid primary key default gen_random_uuid() (if not declared)
 *   - FORCE ROW LEVEL SECURITY
 *   - A per-plugin policy matching current_setting('caelo.plugin_id')
 *
 * Per-column types map to Postgres types:
 *   uuid       → uuid
 *   string     → text
 *   text       → text
 *   int        → integer
 *   bool       → boolean
 *   timestamp  → timestamptz default now()
 *   jsonb      → jsonb
 *   enum:a,b,c → text CHECK (col IN ('a','b','c'))
 *
 */

import type { PluginSchemaMap } from "@caelo-cms/plugin-sdk";

export interface EmittedSchema {
  /** The cms_public sub-schema name (e.g. "plugin_comments"). */
  readonly schemaName: string;
  /** The full SQL the activation path runs in one tx. */
  readonly sql: string;
}

export function schemaFromSpec(opts: {
  pluginId: string;
  slug: string;
  schema: PluginSchemaMap;
}): EmittedSchema {
  const schemaName = `plugin_${opts.slug.replace(/-/g, "_")}`;
  const stmts: string[] = [];

  stmts.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)};`);
  stmts.push(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO public_role;`);
  stmts.push(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO admin_role;`);

  for (const [tableName, columns] of Object.entries(opts.schema)) {
    stmts.push(emitCreateTable(schemaName, tableName, columns, opts.pluginId));
  }

  return { schemaName, sql: stmts.join("\n\n") };
}

function emitCreateTable(
  schemaName: string,
  tableName: string,
  columns: Record<string, string>,
  pluginId: string,
): string {
  const colDefs: string[] = [];
  let hasId = false;
  for (const [colName, spec] of Object.entries(columns)) {
    if (colName === "id") hasId = true;
    colDefs.push(emitColumnDef(colName, spec));
  }
  if (!hasId) {
    colDefs.unshift(`id uuid PRIMARY KEY DEFAULT gen_random_uuid()`);
  }
  const fqTable = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
  const policyName = `${schemaName}_${tableName}_plugin_scope`;
  return [
    `CREATE TABLE IF NOT EXISTS ${fqTable} (`,
    `  ${colDefs.join(",\n  ")}`,
    `);`,
    `ALTER TABLE ${fqTable} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${fqTable} FORCE  ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${fqTable};`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${fqTable}`,
    `  USING (current_setting('caelo.plugin_id', true) = '${pluginId}')`,
    `  WITH CHECK (current_setting('caelo.plugin_id', true) = '${pluginId}');`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${fqTable} TO public_role;`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${fqTable} TO admin_role;`,
  ].join("\n");
}

function emitColumnDef(name: string, spec: string): string {
  const ident = quoteIdent(name);
  if (spec.startsWith("enum:")) {
    const values = spec
      .slice("enum:".length)
      .split(",")
      .map((v) => `'${v.replace(/'/g, "''")}'`);
    return `${ident} text CHECK (${ident} IN (${values.join(", ")}))`;
  }
  switch (spec) {
    case "uuid":
      return name === "id"
        ? `${ident} uuid PRIMARY KEY DEFAULT gen_random_uuid()`
        : `${ident} uuid`;
    case "string":
    case "text":
      return `${ident} text`;
    case "int":
      return `${ident} integer`;
    case "bool":
      return `${ident} boolean`;
    case "timestamp":
      return `${ident} timestamptz NOT NULL DEFAULT now()`;
    case "timestamp_nullable":
      // P12 — for status-flag columns (confirmed_at, unsubscribed_at,
      // email_verified_at, used_at) that mean "when did this event
      // happen". Omit on insert → NULL, write later to record the event.
      return `${ident} timestamptz`;
    case "jsonb":
      return `${ident} jsonb`;
    default:
      throw new Error(`schemaFromSpec: unknown column type "${spec}" for column "${name}"`);
  }
}

/** Defensive identifier quoting. Plugin slugs + table names are
 *  already validated against `[a-z][a-z0-9-_]*` by the manifest +
 *  source schemas, so this is belt-and-suspenders. */
function quoteIdent(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) {
    throw new Error(`schemaFromSpec: refusing to quote identifier "${s}"`);
  }
  return `"${s}"`;
}

// ---------------------------------------------------------------------------
// #389 — cms_admin plugin schema emitter.
// ---------------------------------------------------------------------------

/**
 * Core tables a plugin adminSchema `ref:` column may FK onto. Kept
 * deliberately short: the FK is the plugin's read-consistency anchor
 * into core (ON DELETE CASCADE cleans plugin rows when the core row
 * dies), never a write path. Extending this list is a reviewed core
 * change, not a plugin-side decision.
 */
export const ADMIN_REF_ALLOWLIST: ReadonlySet<string> = new Set([
  "pages",
  "modules",
  "templates",
  "media_assets",
]);

/**
 * Emit the DDL for a release-signed plugin's OWN cms_admin schema
 * (`plugin_<slug>`), per epic #380 decision 3. Differences from the
 * cms_public emitter above:
 *   - grants go to admin_role ONLY (public_role never sees cms_admin);
 *   - `ref:<table>[:cascade]` columns become uuid FKs onto allowlisted
 *     core tables;
 *   - columns are additionally emitted as `ADD COLUMN IF NOT EXISTS`
 *     so a version bump with NEW columns evolves an existing table
 *     (additive-only pre-1.0; destructive change = drop + recreate).
 * Same per-plugin RLS shape: FORCE + policy on caelo.plugin_id.
 */
export function adminSchemaFromSpec(opts: {
  pluginId: string;
  slug: string;
  adminSchema: PluginSchemaMap;
}): EmittedSchema {
  const schemaName = `plugin_${opts.slug.replace(/-/g, "_")}`;
  const stmts: string[] = [];

  stmts.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)};`);
  stmts.push(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO admin_role;`);

  for (const [tableName, columns] of Object.entries(opts.adminSchema)) {
    const fqTable = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
    const colDefs: string[] = [];
    const evolveStmts: string[] = [];
    let hasId = false;
    for (const [colName, spec] of Object.entries(columns)) {
      if (colName === "id") hasId = true;
      const def = emitAdminColumnDef(colName, spec);
      colDefs.push(def);
      if (colName !== "id") {
        evolveStmts.push(`ALTER TABLE ${fqTable} ADD COLUMN IF NOT EXISTS ${def};`);
      }
    }
    if (!hasId) {
      colDefs.unshift(`id uuid PRIMARY KEY DEFAULT gen_random_uuid()`);
    }
    const policyName = `${schemaName}_${tableName}_plugin_scope`;
    stmts.push(
      [
        `CREATE TABLE IF NOT EXISTS ${fqTable} (`,
        `  ${colDefs.join(",\n  ")}`,
        `);`,
        // Additive evolution: no-ops on a fresh table, adds newly
        // declared columns on an existing one.
        ...evolveStmts,
        `ALTER TABLE ${fqTable} ENABLE ROW LEVEL SECURITY;`,
        `ALTER TABLE ${fqTable} FORCE  ROW LEVEL SECURITY;`,
        `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${fqTable};`,
        `CREATE POLICY ${quoteIdent(policyName)} ON ${fqTable}`,
        `  USING (current_setting('caelo.plugin_id', true) = '${opts.pluginId}')`,
        `  WITH CHECK (current_setting('caelo.plugin_id', true) = '${opts.pluginId}');`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${fqTable} TO admin_role;`,
      ].join("\n"),
    );
  }

  return { schemaName, sql: stmts.join("\n\n") };
}

function emitAdminColumnDef(name: string, spec: string): string {
  if (spec.startsWith("ref:")) {
    const [, table, action] = spec.split(":");
    if (!table || !ADMIN_REF_ALLOWLIST.has(table)) {
      throw new Error(
        `adminSchemaFromSpec: ref target "${table ?? ""}" is not in the core-table allowlist (${[...ADMIN_REF_ALLOWLIST].join(", ")})`,
      );
    }
    if (action !== undefined && action !== "cascade") {
      throw new Error(
        `adminSchemaFromSpec: unknown ref action "${action}" for column "${name}" (only "cascade")`,
      );
    }
    const onDelete = action === "cascade" ? " ON DELETE CASCADE" : "";
    // Schema-qualified — core tables live in cms_admin's `public` schema
    // and the DDL tx must not depend on search_path.
    return `${quoteIdent(name)} uuid NOT NULL REFERENCES public.${quoteIdent(table)}(id)${onDelete}`;
  }
  return emitColumnDef(name, spec);
}
