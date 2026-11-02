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
 *   - the visitor role's privileges its declared kind allows, and no more
 *     (#1332, {@link publicTableGrants}); the admin role keeps all four
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

import { createHash } from "node:crypto";
import {
  automaticIndexColumns,
  type NormalizedPluginIndex,
  normalizePluginIndexes,
  type PluginIndexMap,
  type PluginSchemaMap,
  type PluginStorageZone,
  type PluginTableKind,
  type PluginTableKinds,
} from "@caelo-cms/plugin-sdk";

export interface EmittedSchema {
  /** The cms_public sub-schema name (e.g. "plugin_comments"). */
  readonly schemaName: string;
  /** The full SQL the activation path runs in one tx. */
  readonly sql: string;
}

const PLUGIN_UUID_RE = /^[0-9a-f-]{36}$/i;

function assertValidPluginId(pluginId: string, caller: string): void {
  if (!PLUGIN_UUID_RE.test(pluginId)) {
    throw new Error(`${caller}: plugin id "${pluginId}" is not a valid UUID`);
  }
}

export function schemaFromSpec(opts: {
  pluginId: string;
  slug: string;
  schema: PluginSchemaMap;
  /**
   * #1292 — the manifest's `indexes.schema`. Required (pass `undefined`
   * for none): the emitter drops every host index a table no longer
   * declares, so a caller that forgot it would drop the plugin's indexes.
   */
  indexes: PluginIndexMap | undefined;
  /**
   * #1332 — the manifest's `tableKinds`. Required (pass `undefined` only
   * for a plugin without tables): every table's visitor GRANTs come from
   * its kind, and a table without one is refused, never granted a default.
   */
  tableKinds: PluginTableKinds | undefined;
  /** Which public database and roles the GRANTs are for; the live one
   *  unless given. The staging database (#1329) passes its own. */
  target?: PublicGrantTarget;
}): EmittedSchema {
  assertValidPluginId(opts.pluginId, "schemaFromSpec");
  assertIndexedTablesDeclared(opts.indexes, opts.schema, "schema");
  const target = opts.target ?? LIVE_PUBLIC_GRANT_TARGET;
  const schemaName = `plugin_${opts.slug.replace(/-/g, "_")}`;
  const stmts: string[] = [];

  stmts.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)};`);
  for (const role of [target.visitorRole, target.adminRole]) {
    stmts.push(grantStatement(target.database, "USAGE", `SCHEMA ${quoteIdent(schemaName)}`, role));
  }

  for (const [tableName, columns] of Object.entries(opts.schema)) {
    const kind = opts.tableKinds?.[tableName];
    if (!kind) {
      throw new Error(
        `schemaFromSpec: table "${tableName}" of plugin "${opts.slug}" has no kind — declare it in tableKinds (published, inbox, visitor-state or private)`,
      );
    }
    stmts.push(emitCreateTable(schemaName, tableName, columns, opts.pluginId));
    const fqTable = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
    stmts.push(publicTableGrants(fqTable, kind, target).join("\n"));
    stmts.push(
      emitIndexes(schemaName, tableName, columns, "schema", opts.indexes?.[tableName] ?? []),
    );
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
    dropUndeclaredColumns(schemaName, tableName, Object.keys(columns)),
    `ALTER TABLE ${fqTable} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${fqTable} FORCE  ROW LEVEL SECURITY;`,
    pluginScopePolicy(fqTable, policyName, pluginId),
  ].join("\n");
}

/**
 * #1332 — a public plugin database the visitor GRANTs are generated for:
 * which database, the role visitors' requests run as there, and the
 * admin's role. One generator for every such database, so the live and
 * the staging database (#1329) cannot drift apart.
 */
export interface PublicGrantTarget {
  readonly database: Exclude<PluginSchemaDatabase, "cms_admin">;
  readonly visitorRole: string;
  readonly adminRole: string;
}

/** The live public database: the gateway runs as `public_role`. */
export const LIVE_PUBLIC_GRANT_TARGET: PublicGrantTarget = Object.freeze({
  database: "cms_public",
  visitorRole: "public_role",
  adminRole: "admin_role",
});

/**
 * #1332 (E10) — what the visitor role may do with a table of each kind.
 * Enforced by Postgres, because the boundary assumes the gateway is
 * compromised (docs/dev/public-admin-boundary.md): a host check alone
 * would not hold against a gateway that runs other code.
 */
export const VISITOR_TABLE_PRIVILEGES: Readonly<Record<PluginTableKind, readonly string[]>> = {
  published: ["SELECT"],
  inbox: ["INSERT"],
  "visitor-state": ["SELECT", "INSERT", "UPDATE", "DELETE"],
  private: [],
};

/**
 * The privilege statements of one public plugin table. Everything the
 * visitor role held is revoked first, so a kind that narrows (or a table
 * provisioned before kinds existed, with all four) takes effect on the
 * next load; then the kind's privileges are granted. The admin role keeps
 * all four in every kind: it moderates the inbox and writes the published
 * rows through the plugin's own operations.
 *
 * FIXME(issue #1333): `rating_aggregates` is published, but the ratings
 * worker recomputes it in the admin and writes it straight into this one
 * database with the admin role, instead of publishing it through the
 * projection to every public database. That direct write is the reason
 * the admin role keeps write privileges on published tables here; once
 * #1333 moves the recompute to the projection, published tables drop it.
 *
 * @param fqTable the quoted `schema.table`
 */
export function publicTableGrants(
  fqTable: string,
  kind: PluginTableKind,
  target: PublicGrantTarget,
): string[] {
  const visitor = VISITOR_TABLE_PRIVILEGES[kind];
  return [
    revokeStatement(target.database, fqTable, target.visitorRole),
    ...(visitor.length > 0
      ? [grantStatement(target.database, visitor.join(", "), fqTable, target.visitorRole)]
      : []),
    grantStatement(target.database, "SELECT, INSERT, UPDATE, DELETE", fqTable, target.adminRole),
  ];
}

/**
 * The policy that scopes a plugin table to its plugin: only a session
 * whose `caelo.plugin_id` is this plugin's id sees or writes a row.
 *
 * Spelled through `caelo_setting_is` (migration 0475), not as
 * `current_setting('caelo.plugin_id', true) = '<id>'`: Postgres never
 * treats a policy qual as a one-time filter, so the plain comparison is a
 * row filter estimated at 0.5 % of the rows (no statistics on either
 * side), and an unfiltered `ORDER BY … LIMIT` read planned a full scan +
 * sort instead of reading its index in order (#1297). The helper inlines
 * to a NullTest the planner estimates at 99.5 %, with the same truth
 * table (a missing setting matches nothing).
 */
function pluginScopePolicy(fqTable: string, policyName: string, pluginId: string): string {
  const scope = `caelo_setting_is('caelo.plugin_id', '${pluginId}')`;
  return [
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${fqTable};`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${fqTable}`,
    `  USING (${scope})`,
    `  WITH CHECK (${scope});`,
  ].join("\n");
}

/**
 * The GUC the drop blocks append `<table>.<column>` entries to, so the
 * provisioning transaction can audit what it dropped
 * (`provisionPluginSchemaInTx`). Transaction-local.
 */
export const DROPPED_COLUMNS_SETTING = "caelo.plugin_dropped_columns";

/**
 * #1146 — drop the columns of a plugin table its spec no longer declares.
 *
 * Provisioning only ever added columns, so a column a new plugin version
 * removed stayed on every install with its old values: three columns that
 * held visitor ids outlived the purpose they were collected for (#1145).
 * Pre-1.0, destructive schema changes are allowed (CLAUDE.md §2). The
 * row id and every host-owned `caelo_` column are never touched; each
 * dropped column is recorded in {@link DROPPED_COLUMNS_SETTING} for the
 * audit row.
 */
function dropUndeclaredColumns(schemaName: string, tableName: string, declared: string[]): string {
  const keep = [...new Set(["id", ...declared])].map((c) => `'${quoteIdent(c).slice(1, -1)}'`);
  const schema = `'${quoteIdent(schemaName).slice(1, -1)}'`;
  const table = `'${quoteIdent(tableName).slice(1, -1)}'`;
  return [
    "DO $caelo_drop$",
    "DECLARE",
    "  col text;",
    `  dropped text := coalesce(current_setting('${DROPPED_COLUMNS_SETTING}', true), '');`,
    "BEGIN",
    "  FOR col IN",
    "    SELECT column_name FROM information_schema.columns",
    `     WHERE table_schema = ${schema} AND table_name = ${table}`,
    "       AND column_name NOT LIKE 'caelo\\_%'",
    `       AND column_name <> ALL (ARRAY[${keep.join(", ")}]::text[])`,
    "  LOOP",
    `    EXECUTE format('ALTER TABLE %I.%I DROP COLUMN %I', ${schema}, ${table}, col);`,
    `    dropped := dropped || ${table} || '.' || col || ',';`,
    "  END LOOP;",
    `  PERFORM set_config('${DROPPED_COLUMNS_SETTING}', dropped, true);`,
    "END",
    "$caelo_drop$;",
  ].join("\n");
}

/** Every index the host creates on a plugin table starts with this. */
export const PLUGIN_INDEX_PREFIX = "caelo_ix_";

/**
 * The predicate of a private-storage index on declared columns: exactly
 * the main-line filter every host read of that zone carries (`privateList`
 * and the reads beside it), so the planner can use the index for them and
 * branch rows and tombstones never bloat it.
 */
export const PRIVATE_LIVE_ROW_PREDICATE =
  `"caelo_chat_branch_id" IS NULL AND "caelo_deleted_at" IS NULL` as const;

interface EmittedIndex {
  readonly name: string;
  readonly sql: string;
}

/**
 * #1292 — a deterministic, length-safe index name. Readable part first
 * (table + columns, cut to fit), then 8 hex of a hash over the whole
 * definition (columns, uniqueness, predicate, method), so an index whose
 * definition changes gets a new name — the old one is dropped and the
 * new one built — and two long definitions never truncate into one name.
 */
export function pluginIndexName(
  table: string,
  columns: readonly string[],
  unique: boolean,
  predicate: string,
  method: "btree" | "hash" = "btree",
): string {
  // `method` enters the hash only when it is not the default btree, so a
  // btree index keeps the name it had before hash indexes existed.
  const definition =
    method === "btree"
      ? { table, columns, unique, predicate }
      : { table, columns, unique, predicate, method };
  const digest = createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 8);
  const room = 63 - PLUGIN_INDEX_PREFIX.length - digest.length - 1;
  const readable = `${table}_${columns.join("_")}`.slice(0, room).replace(/_+$/, "");
  return `${PLUGIN_INDEX_PREFIX}${readable}_${digest}`;
}

/** Every table `indexes` names must be one the zone declares. */
function assertIndexedTablesDeclared(
  indexes: PluginIndexMap | undefined,
  tables: PluginSchemaMap,
  zone: PluginStorageZone,
): void {
  for (const table of Object.keys(indexes ?? {})) {
    if (!(table in tables)) {
      throw new Error(
        `plugin schema: indexes.${zone} names table "${table}", which ${zone} does not declare`,
      );
    }
  }
}

/**
 * #1292 — the indexes of one plugin table: the declared ones and, in
 * private storage, the automatic ones (each `ref:` column, which a core
 * delete cascades by; the host's branch column, which a chat's publish
 * and discard select by). Then every `caelo_ix_` index of the table that
 * is not in this set is dropped — a new version that stops declaring an
 * index loses it, like #1146 drops undeclared columns.
 *
 * The manifest validator already refused bad declarations
 * (`checkPluginIndexes`); the checks here keep the DDL safe on their own.
 */
function emitIndexes(
  schemaName: string,
  tableName: string,
  columns: Readonly<Record<string, string>>,
  zone: PluginStorageZone,
  specs: Parameters<typeof normalizePluginIndexes>[0],
): string {
  const fqTable = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
  const out: EmittedIndex[] = [];
  const add = (
    cols: readonly string[],
    unique: boolean,
    predicate: string,
    method: "btree" | "hash" = "btree",
  ) => {
    const name = pluginIndexName(tableName, cols, unique, predicate, method);
    const where = predicate === "" ? "" : ` WHERE ${predicate}`;
    const using = method === "hash" ? " USING hash" : "";
    out.push({
      name,
      sql: `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${fqTable}${using} (${cols.map(quoteIdent).join(", ")})${where};`,
    });
  };
  for (const index of normalizePluginIndexes(specs)) {
    assertIndexable(zone, tableName, columns, index);
    add(
      index.columns,
      index.unique,
      zone === "adminSchema" ? PRIVATE_LIVE_ROW_PREDICATE : "",
      index.method,
    );
  }
  if (zone === "adminSchema") {
    for (const ref of automaticIndexColumns(zone, columns)) add([ref], false, "");
    add(["caelo_chat_branch_id"], false, `"caelo_chat_branch_id" IS NOT NULL`);
  }
  const keep = out.map((ix) => `'${ix.name}'`);
  return [
    ...out.map((ix) => ix.sql),
    "DO $caelo_indexes$",
    "DECLARE",
    "  ix text;",
    "BEGIN",
    "  FOR ix IN",
    "    SELECT indexname FROM pg_indexes",
    `     WHERE schemaname = '${schemaName}' AND tablename = '${tableName}'`,
    // starts_with, not LIKE: "_" is a LIKE wildcard in the prefix.
    `       AND starts_with(indexname, '${PLUGIN_INDEX_PREFIX}')`,
    `       AND indexname <> ALL (ARRAY[${keep.join(", ")}]::text[])`,
    "  LOOP",
    `    EXECUTE format('DROP INDEX %I.%I', '${schemaName}', ix);`,
    "  END LOOP;",
    "END",
    "$caelo_indexes$;",
  ].join("\n");
}

function assertIndexable(
  zone: PluginStorageZone,
  table: string,
  columns: Readonly<Record<string, string>>,
  index: NormalizedPluginIndex,
): void {
  for (const c of index.columns) {
    if (c.startsWith("caelo_") || (c !== "id" && !(c in columns)) || columns[c] === "jsonb") {
      throw new Error(
        `plugin schema: indexes.${zone}.${table} cannot index "${c}" — only declared, non-jsonb columns (and id after one of them)`,
      );
    }
  }
  if (index.method === "hash" && (index.columns.length !== 1 || index.unique)) {
    throw new Error(
      `plugin schema: indexes.${zone}.${table}: a hash index is one column and not unique`,
    );
  }
  if (index.unique && zone === "adminSchema") {
    throw new Error(
      `plugin schema: indexes.adminSchema.${table}: unique indexes are cms_public only`,
    );
  }
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
 * The revocation half of {@link publicTableGrants}, held to the same role
 * set as {@link grantStatement}: the emitters never touch the privileges
 * of a role they may not grant to.
 */
function revokeStatement(database: PluginSchemaDatabase, object: string, role: string): string {
  if (!PLUGIN_SCHEMA_GRANTEES[database].has(role)) {
    throw new Error(
      `plugin schema: refusing to REVOKE ON ${object} FROM ${role} in ${database} — only ${[...PLUGIN_SCHEMA_GRANTEES[database]].join(", ")} hold plugin-schema privileges there`,
    );
  }
  return `REVOKE ALL ON ${object} FROM ${role};`;
}

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
 * The only way the emitters write a GRANT, so no code path can grant a
 * plugin schema to a role outside {@link PLUGIN_SCHEMA_GRANTEES}. (The
 * expand release also let the former gateway_role keep read-only grants;
 * this contract release dropped the role and that allowance.)
 *
 * @throws when `grantee` may not hold `privileges` in `database`.
 */
export function grantStatement(
  database: PluginSchemaDatabase,
  privileges: string,
  object: string,
  grantee: string,
): string {
  if (!PLUGIN_SCHEMA_GRANTEES[database].has(grantee)) {
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
 *     so a version bump with NEW columns evolves an existing table, and
 *     columns it no longer declares are dropped (#1146; both emitters).
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
   * Issue #635 — the tables of the plugin's declared `visitorProjection`.
   * Each gets a statement trigger that marks the plugin's projection
   * section stale in `public_projection_outbox` (cms_admin migration
   * 0281), so the admin republishes it into cms_public after any write —
   * an op, a branch publish, a revert. Tables not named lose the trigger.
   */
  projectedTables?: ReadonlyArray<string>;
  /** #1292 — the manifest's `indexes.adminSchema`; see {@link schemaFromSpec}. */
  indexes: PluginIndexMap | undefined;
}): EmittedSchema {
  assertValidPluginId(opts.pluginId, "adminSchemaFromSpec");
  assertIndexedTablesDeclared(opts.indexes, opts.adminSchema, "adminSchema");
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
        dropUndeclaredColumns(schemaName, tableName, Object.keys(columns)),
        `ALTER TABLE ${fqTable} ENABLE ROW LEVEL SECURITY;`,
        `ALTER TABLE ${fqTable} FORCE  ROW LEVEL SECURITY;`,
        pluginScopePolicy(fqTable, policyName, opts.pluginId),
        grantStatement("cms_admin", "SELECT, INSERT, UPDATE, DELETE", fqTable, "admin_role"),
        emitIndexes(schemaName, tableName, columns, "adminSchema", opts.indexes?.[tableName] ?? []),
      ].join("\n"),
    );
  }

  stmts.push(revokeFormerGatewayGrants(schemaName));
  stmts.push(projectionTriggers(schemaName, opts.pluginId, opts.adminSchema, opts.projectedTables));

  return { schemaName, sql: stmts.join("\n\n") };
}

/**
 * The columns a private-storage read selects: the row's id, the declared
 * columns and the host columns the reads filter on. Exported so the
 * storage read (plugin-host `privateList`) selects exactly these and a
 * column a plugin update dropped from its spec never comes back.
 */
export function privateReadColumns(columns: Readonly<Record<string, string>>): string[] {
  return [
    ...new Set([
      "id",
      ...Object.keys(columns),
      ...PRIVATE_HOST_COLUMN_DEFS.map((d) => d.split(" ")[0] as string),
    ]),
  ];
}

/**
 * Issue #635 — the API gateway has no cms_admin login; it reads only the
 * `visitorProjection` the admin publishes into cms_public. A database from
 * before still has the former `gateway_role` (until bootstrap.sh / the
 * self-hosted role setup drops it) with SELECT grants on this schema:
 * revoke them on every provisioning. Guarded on the role existing.
 */
function revokeFormerGatewayGrants(schemaName: string): string {
  const schema = quoteIdent(schemaName);
  return [
    "DO $caelo_gateway$",
    "BEGIN",
    "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN",
    `    REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM gateway_role;`,
    `    REVOKE ALL ON SCHEMA ${schema} FROM gateway_role;`,
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
