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
  stmts.push(
    grantStatement("cms_public", "USAGE", `SCHEMA ${quoteIdent(schemaName)}`, "public_role"),
  );
  stmts.push(
    grantStatement("cms_public", "USAGE", `SCHEMA ${quoteIdent(schemaName)}`, "admin_role"),
  );

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
    assertNotHostColumn(colName, tableName);
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
    ...Object.entries(columns)
      .filter(([name]) => name !== "id")
      .map(
        ([name, spec]) =>
          `ALTER TABLE ${fqTable} ADD COLUMN IF NOT EXISTS ${emitColumnDef(name, spec)};`,
      ),
    `ALTER TABLE ${fqTable} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${fqTable} FORCE  ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${fqTable};`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${fqTable}`,
    `  USING (current_setting('caelo.plugin_id', true) = '${pluginId}')`,
    `  WITH CHECK (current_setting('caelo.plugin_id', true) = '${pluginId}');`,
    grantStatement("cms_public", "SELECT, INSERT, UPDATE, DELETE", fqTable, "public_role"),
    grantStatement("cms_public", "SELECT, INSERT, UPDATE, DELETE", fqTable, "admin_role"),
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

/** The database a plugin schema's DDL runs in. */
export type PluginSchemaDatabase = "cms_admin" | "cms_public";

/**
 * Issue #635 — the roles plugin schema DDL may grant to, per database. The
 * admin runs this DDL at every boot, so this is the runtime twin of the
 * migration grant lint: cms_admin grants go to admin_role (the public side
 * has no path to cms_admin, CLAUDE.md §2); cms_public grants go to
 * public_role (the gateway and the Tier 2 sandbox) and admin_role.
 */
export const PLUGIN_SCHEMA_GRANTEES: Readonly<Record<PluginSchemaDatabase, ReadonlySet<string>>> = {
  cms_admin: new Set(["admin_role"]),
  cms_public: new Set(["public_role", "admin_role"]),
};

/**
 * Issue #635, expand release — the former gateway_role keeps READ-ONLY
 * access to a visitor-serving plugin's private tables (#613) until the
 * contract release drops the role: while an upgrade rolls, and after a
 * rollback, the previous release's gateway still reads them as
 * gateway_role. Only `USAGE` on a schema and column-level `SELECT (…)`:
 * never table-wide, never a write. The contract release removes this set.
 */
export const LEGACY_READ_ONLY_GRANTEES: Readonly<
  Record<PluginSchemaDatabase, ReadonlySet<string>>
> = {
  cms_admin: new Set(["gateway_role"]),
  cms_public: new Set(),
};

const READ_ONLY_PRIVILEGES = /^(?:USAGE|SELECT \([^()]+\))$/;

/**
 * The only way the emitters write a GRANT, so no code path can grant a
 * plugin schema to a role outside {@link PLUGIN_SCHEMA_GRANTEES} (or a
 * read-only privilege outside {@link LEGACY_READ_ONLY_GRANTEES}).
 *
 * @throws when `grantee` may not hold `privileges` in `database`.
 */
export function grantStatement(
  database: PluginSchemaDatabase,
  privileges: string,
  object: string,
  grantee: string,
): string {
  const allowed =
    PLUGIN_SCHEMA_GRANTEES[database].has(grantee) ||
    (LEGACY_READ_ONLY_GRANTEES[database].has(grantee) && READ_ONLY_PRIVILEGES.test(privileges));
  if (!allowed) {
    throw new Error(
      `plugin schema: refusing to GRANT ${privileges} ON ${object} TO ${grantee} in ${database} — only ${[...PLUGIN_SCHEMA_GRANTEES[database]].join(", ")} may hold plugin-schema privileges there (CLAUDE.md §2, #635)`,
    );
  }
  return `GRANT ${privileges} ON ${object} TO ${grantee};`;
}

/** Defensive identifier quoting. Plugin slugs + table names are
 *  already validated against `[a-z][a-z0-9-_]*` by the manifest +
 *  source schemas, so this is belt-and-suspenders. */
function quoteIdent(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) {
    throw new Error(`schemaFromSpec: refusing to quote identifier "${s}"`);
  }
  // Postgres truncates identifiers past 63 bytes without an error, so two
  // distinct long names would address the same schema, table or policy.
  if (s.length > 63) {
    throw new Error(
      `schemaFromSpec: identifier "${s}" is longer than Postgres' 63-byte limit — shorten the plugin slug or table name`,
    );
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
/** Host-owned columns every private-zone plugin table carries. */
const PRIVATE_HOST_COLUMN_DEFS = [
  "caelo_chat_branch_id uuid NULL",
  "caelo_deleted_at timestamptz NULL",
  "caelo_version integer NOT NULL DEFAULT 1",
  "caelo_updated_at timestamptz NOT NULL DEFAULT now()",
] as const;

/** `caelo_` columns belong to the host; a manifest declaring one is rejected. */
function assertNotHostColumn(column: string, table: string): void {
  if (column.startsWith("caelo_")) {
    throw new Error(
      `plugin schema: column "${column}" on table "${table}" uses the reserved "caelo_" prefix — rename it; those columns are host-owned`,
    );
  }
}

export function adminSchemaFromSpec(opts: {
  pluginId: string;
  slug: string;
  adminSchema: PluginSchemaMap;
  /**
   * Issue #613 — the plugin serves visitors (`publicOperations`) and those
   * operations may read its private tables, so the API gateway's
   * `gateway_role` gets SELECT on them. Read-only: a visitor call never
   * writes private storage. When false, any earlier grant is revoked, so a
   * plugin that stops serving visitors converges on the next load.
   */
  visitorReadable?: boolean;
  /**
   * Issue #635 — the tables of the plugin's declared `visitorProjection`.
   * Each gets a statement trigger that marks the plugin's projection
   * section stale in `public_projection_outbox` (cms_admin migration
   * 0281), so the admin republishes it into cms_public after any write —
   * an op, a branch publish, a revert. Tables not named lose the trigger.
   */
  projectedTables?: ReadonlyArray<string>;
}): EmittedSchema {
  const schemaName = `plugin_${opts.slug.replace(/-/g, "_")}`;
  const stmts: string[] = [];

  stmts.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)};`);
  stmts.push(
    grantStatement("cms_admin", "USAGE", `SCHEMA ${quoteIdent(schemaName)}`, "admin_role"),
  );

  for (const [tableName, columns] of Object.entries(opts.adminSchema)) {
    const fqTable = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
    const colDefs: string[] = [];
    const evolveStmts: string[] = [];
    let hasId = false;
    for (const [colName, spec] of Object.entries(columns)) {
      assertNotHostColumn(colName, tableName);
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
    // Host-owned branch + history columns (docs/branch-aware-plugin-
    // storage.md). Only the storage operations write them; a plugin can
    // neither declare, read nor write a caelo_ column.
    for (const def of PRIVATE_HOST_COLUMN_DEFS) {
      colDefs.push(def);
      evolveStmts.push(`ALTER TABLE ${fqTable} ADD COLUMN IF NOT EXISTS ${def};`);
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
        grantStatement("cms_admin", "SELECT, INSERT, UPDATE, DELETE", fqTable, "admin_role"),
      ].join("\n"),
    );
  }

  stmts.push(gatewayReadGrants(schemaName, opts.adminSchema, opts.visitorReadable));
  stmts.push(projectionTriggers(schemaName, opts.pluginId, opts.adminSchema, opts.projectedTables));

  return { schemaName, sql: stmts.join("\n\n") };
}

/**
 * The columns the gateway may read on a private table: its id, the declared
 * columns and the host columns private-storage reads filter on. Exported
 * so the storage read (plugin-host `privateList`) selects exactly these.
 */
export function gatewayReadableColumns(columns: Readonly<Record<string, string>>): string[] {
  return [
    ...new Set([
      "id",
      ...Object.keys(columns),
      ...PRIVATE_HOST_COLUMN_DEFS.map((d) => d.split(" ")[0] as string),
    ]),
  ];
}

/**
 * Issue #613 — the API gateway's read access to a plugin's private tables,
 * recomputed from the CURRENT spec on every provisioning: everything the
 * role held on the schema is revoked first (revoking on a table also
 * revokes its column privileges), then SELECT is granted column by column
 * on the declared tables only. A table or column a plugin update dropped
 * from its spec stays physically (evolution is additive) but is no longer
 * readable by the gateway. Guarded on the role existing: a database
 * bootstrapped before `gateway_role` (migration 0248) still provisions.
 */
function gatewayReadGrants(
  schemaName: string,
  adminSchema: PluginSchemaMap,
  visitorReadable: boolean | undefined,
): string {
  const schema = quoteIdent(schemaName);
  const revoke = [
    `    REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM gateway_role;`,
    `    REVOKE ALL ON SCHEMA ${schema} FROM gateway_role;`,
  ];
  const grant = visitorReadable
    ? [
        `    ${grantStatement("cms_admin", "USAGE", `SCHEMA ${schema}`, "gateway_role")}`,
        ...Object.entries(adminSchema).map(
          ([t, columns]) =>
            `    ${grantStatement(
              "cms_admin",
              `SELECT (${gatewayReadableColumns(columns).map(quoteIdent).join(", ")})`,
              `${schema}.${quoteIdent(t)}`,
              "gateway_role",
            )}`,
        ),
      ]
    : [];
  return [
    "DO $caelo_gateway$",
    "BEGIN",
    "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN",
    ...revoke,
    ...grant,
    "  END IF;",
    "END",
    "$caelo_gateway$;",
  ].join("\n");
}

/**
 * Issue #635 — keep a plugin's published projection current: a statement
 * trigger on each projected table marks section `plugin:<id>` stale, and
 * every other table of the schema has the trigger dropped (a table that
 * left the projection stops waking the publisher). Guarded on the
 * trigger function existing, so a database older than migration 0281
 * still provisions.
 */
function projectionTriggers(
  schemaName: string,
  pluginId: string,
  adminSchema: PluginSchemaMap,
  projectedTables: ReadonlyArray<string> | undefined,
): string {
  if (!/^[0-9a-f-]{36}$/i.test(pluginId)) {
    throw new Error(`adminSchemaFromSpec: plugin id "${pluginId}" is not a UUID`);
  }
  const projected = new Set(projectedTables ?? []);
  for (const t of projected) {
    if (!(t in adminSchema)) {
      throw new Error(`adminSchemaFromSpec: projected table "${t}" is not in adminSchema`);
    }
  }
  const schema = quoteIdent(schemaName);
  const lines = Object.keys(adminSchema).flatMap((t) => {
    const fq = `${schema}.${quoteIdent(t)}`;
    const drop = `    DROP TRIGGER IF EXISTS caelo_projection ON ${fq};`;
    if (!projected.has(t)) return [drop];
    return [
      drop,
      `    CREATE TRIGGER caelo_projection AFTER INSERT OR UPDATE OR DELETE ON ${fq}`,
      `      FOR EACH STATEMENT EXECUTE FUNCTION caelo_mark_public_projection('plugin:${pluginId.toLowerCase()}');`,
    ];
  });
  return [
    "DO $caelo_projection$",
    "BEGIN",
    "  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'caelo_mark_public_projection') THEN",
    ...lines,
    "  END IF;",
    "END",
    "$caelo_projection$;",
  ].join("\n");
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
