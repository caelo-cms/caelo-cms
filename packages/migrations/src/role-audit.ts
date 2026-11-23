// SPDX-License-Identifier: MPL-2.0

/**
 * The application-role isolation audit (issue #633, CLAUDE.md §2: "admin_role
 * and public_role are isolated").
 *
 * On Cloud SQL every user the Admin API creates — `public_role` among them —
 * joins `cloudsqlsuperuser` and gets CREATEROLE + CREATEDB. That handed the
 * visitor-facing login (the API gateway's cms_public connection) the
 * privileges of the group that owns both databases. `cms-provision` now
 * revokes those memberships through the Admin API (the identity that granted
 * them) and migration 0278 drops what SQL may drop; this audit is the guard
 * that proves the result. migrate.ts runs it after every cms_admin migration
 * run — install, `upgrade`, the in-cloud upgrader, self-hosted — and refuses
 * (non-zero exit, before any traffic moves) while a violation remains, so an
 * install can never silently keep or regain the over-privilege.
 *
 * Every role and database is named through the install's name map (#1689,
 * `@caelo-cms/shared` install-names.ts; the default map is the names below).
 * Which role may hold what:
 *
 *   - `admin_role` is the authoring + migration role. On Cloud SQL it needs
 *     `cloudsqlsuperuser`: the Admin API makes that group the owner of
 *     cms_admin / cms_public (and so of their `public` schemas), and the
 *     migrations create roles and extensions. Its attributes are not
 *     audited; that it reaches no other install's database is.
 *   - `public_role` (the public gateway's only login) and the former
 *     `gateway_role` (#635: gone, or left without any privilege where the
 *     migration role could not drop it): no role membership at all, no
 *     SUPERUSER / BYPASSRLS / REPLICATION, and no CONNECT on cms_admin.
 *     public_role must also carry its database limits
 *     ({@link PUBLIC_ROLE_LIMITS}, #1338).
 *   - `operator_access_reader`, `platform_updater` (NOLOGIN roles of the
 *     in-cloud jobs) and every login that is a member of them (the jobs'
 *     Cloud SQL IAM users, the self-hosted update agent): no membership in a
 *     privileged group ({@link privilegedGroups}), no SUPERUSER / BYPASSRLS
 *     / REPLICATION.
 *
 * Issue #635 extends the guard to the whole public side: no privilege on
 * any cms_admin object may be held by public_role or PUBLIC
 * ({@link crossDatabaseGrantsSql}), and cms_public may hold no bridge to
 * another database ({@link assertPublicDatabaseIsolated}, run by migrate.ts
 * on the cms_public target).
 *
 * Issue #1689 extends it across installs on one Postgres server: no login
 * or job role of this install may connect to another install's database
 * ({@link crossInstallConnectSql}), and nothing in this install's databases
 * may be owned by, granted to or name in a policy a role of another
 * install ({@link foreignReferencesSql}). "Another install's" is decided
 * by the database, not by a name: a role that is not this install's and
 * may connect to a database that is neither this install's nor open to
 * every login. That holds for any naming scheme, and a single install on
 * its own server — where no such database exists — sees no change.
 *
 * CREATEROLE / CREATEDB are reported as warnings, not violations: migration
 * 0278 drops them where the migration role may alter the role, but whether
 * Cloud SQL lets admin_role alter a role the Admin API created is not
 * something Caelo controls, and without a privileged group neither attribute
 * reaches existing data (PostgreSQL 16+ lets a CREATEROLE role manage only
 * the roles it created).
 */

import {
  type InstallNames,
  installDatabases,
  installRoles,
  type LogicalDatabase,
  parseInstallNames,
  physicalDatabaseName,
  SERVER_DATABASES,
} from "@caelo-cms/shared";

/** A public database, by its logical name (#1329). */
export type PublicDatabase = Exclude<LogicalDatabase, "cms_admin">;

/** Every public database, live first. */
export const PUBLIC_DATABASES: readonly PublicDatabase[] = ["cms_public", "cms_public_staging"];

/**
 * The one gateway login each public database belongs to (#1329): the live
 * gateway logs in as public_role on cms_public, the staging gateway as
 * public_staging_role on cms_public_staging. Neither login may reach the
 * other's database, and neither database may grant anything to the other's
 * login, so a compromised staging gateway reaches no live data and the
 * reverse.
 */
export function publicDatabaseLogin(names: InstallNames, database: PublicDatabase): string {
  return database === "cms_public" ? names.roles.public : names.roles.publicStaging;
}

/** The visitor-facing logins: one per public database. */
export function visitorLoginRoles(names: InstallNames): string[] {
  return PUBLIC_DATABASES.map((db) => publicDatabaseLogin(names, db));
}

/**
 * The public gateways' logins, and the live gateway's former cms_admin
 * login (gone since #635).
 */
export function gatewayLoginRoles(names: InstallNames): string[] {
  return [...visitorLoginRoles(names), names.roles.formerGateway];
}

/** NOLOGIN roles whose members are the in-cloud jobs' logins. */
export function jobRoles(names: InstallNames): string[] {
  return [names.roles.operatorAccessReader, names.roles.platformUpdater];
}

/**
 * The managed-Postgres "almost superuser" groups (Cloud SQL, RDS, Azure).
 * Install names may not start like them (install-names.ts), so a rule that
 * names them can never be met by a Caelo role.
 */
const MANAGED_GROUPS = ["cloudsqlsuperuser", "rds_superuser", "azure_pg_admin"] as const;

/**
 * Groups that carry privileges far beyond any application grant: the
 * managed-Postgres "almost superuser" groups, the authoring role itself,
 * and the predefined roles that read, write or execute outside the RLS
 * model.
 */
export function privilegedGroups(names: InstallNames): string[] {
  return [
    ...MANAGED_GROUPS,
    names.roles.admin,
    "pg_read_all_data",
    "pg_write_all_data",
    "pg_read_server_files",
    "pg_write_server_files",
    "pg_execute_server_program",
    "pg_create_subscription",
  ];
}

/**
 * `values` as a SQL list of literals. Every value is an install name; a
 * map that did not pass the schema (a hand-built object) is refused before
 * any of it reaches a statement.
 */
function sqlList(values: readonly string[]): string {
  for (const v of values) {
    if (!/^[a-z_][a-z0-9_]*$/.test(v)) {
      throw new Error(`role audit: "${v}" is not a role or database name`);
    }
  }
  return values.map((v) => `'${v}'`).join(", ");
}

/** `names`, validated: the audit builds SQL from them. */
function checked(names: InstallNames): InstallNames {
  return parseInstallNames(names, "the role audit's install names");
}

/** One audited role, as {@link roleAuditSql} returns it. */
export interface AuditedRole {
  readonly rolname: string;
  /** Why it is audited: a gateway login, a job role, or a member of a job role. */
  readonly kind: "gateway-login" | "job-role" | "job-member";
  readonly rolsuper: boolean;
  readonly rolcreaterole: boolean;
  readonly rolcreatedb: boolean;
  readonly rolbypassrls: boolean;
  readonly rolreplication: boolean;
  /** Every role it is a member of, directly or through other roles. */
  readonly memberOf: readonly string[];
  /** Whether it may connect to the database the audit runs in (the install's admin database). */
  readonly canConnectHere: boolean;
  /** #1329 — the install's public databases it may connect to (physical names). */
  readonly publicDatabases: readonly string[];
  /** `pg_roles.rolconnlimit` (-1 = unlimited). */
  readonly connectionLimit: number;
  /** `pg_roles.rolconfig`: the role's own `name=value` settings. */
  readonly settings: readonly string[];
}

/**
 * Issue #1338 — the limits public_role must carry (cms_admin migration
 * 0500 sets them where the migration role may, bootstrap.sh everywhere
 * else; the reasons live in that migration). The connection limit is the
 * gateway's share of the pool budget at the default scale-out
 * (`GATEWAY_ROLE_CONNECTION_LIMIT` in @caelo-cms/shared pool-budget.ts,
 * pinned to this value by a test). Since #1329 the staging gateway's
 * public_staging_role must carry the same values (cms_admin migration 0530).
 */
export const PUBLIC_ROLE_LIMITS = {
  connectionLimit: 30,
  settings: {
    statement_timeout: "5s",
    idle_in_transaction_session_timeout: "15s",
    work_mem: "1MB",
  },
} as const;

/**
 * The audit query. Run while connected to the install's admin database
 * (the CONNECT check is against the current database). Roles that do not
 * exist are simply absent. Members of the job roles exclude the admin
 * role, which bootstrap.sh makes a member so the integration tests can SET
 * ROLE to them.
 */
export function roleAuditSql(installNames: InstallNames): string {
  const names = checked(installNames);
  const gateways = sqlList(gatewayLoginRoles(names));
  const jobs = sqlList(jobRoles(names));
  return `
WITH RECURSIVE membership(member, roleid) AS (
  SELECT member, roleid FROM pg_auth_members
  UNION
  SELECT m.member, a.roleid FROM membership m JOIN pg_auth_members a ON a.member = m.roleid
),
audited(oid, kind) AS (
  SELECT r.oid, 'gateway-login' FROM pg_roles r
   WHERE r.rolname IN (${gateways})
  UNION
  SELECT r.oid, 'job-role' FROM pg_roles r
   WHERE r.rolname IN (${jobs})
  UNION
  SELECT a.member, 'job-member' FROM pg_auth_members a
    JOIN pg_roles g ON g.oid = a.roleid
    JOIN pg_roles m ON m.oid = a.member
   WHERE g.rolname IN (${jobs})
     AND m.rolname <> ${sqlList([names.roles.admin])}
     AND m.rolname NOT IN (${gateways}, ${jobs})
)
SELECT r.rolname::text AS rolname,
       a.kind::text AS kind,
       r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
       COALESCE(
         (SELECT array_agg(DISTINCT g.rolname::text ORDER BY g.rolname::text)
            FROM membership m JOIN pg_roles g ON g.oid = m.roleid
           WHERE m.member = r.oid),
         ARRAY[]::text[]
       ) AS member_of,
       has_database_privilege(r.oid, current_database(), 'CONNECT') AS can_connect_here,
       COALESCE(
         (SELECT array_agg(d.datname::text ORDER BY d.datname::text)
            FROM pg_database d
           WHERE d.datname IN (${sqlList(PUBLIC_DATABASES.map((db) => physicalDatabaseName(names, db)))})
             AND has_database_privilege(r.oid, d.oid, 'CONNECT')),
         ARRAY[]::text[]
       ) AS public_databases,
       r.rolconnlimit AS connection_limit,
       COALESCE(r.rolconfig, ARRAY[]::text[]) AS settings
  FROM audited a JOIN pg_roles r ON r.oid = a.oid
 ORDER BY r.rolname
`;
}

/** A raw row of {@link roleAuditSql}. */
export interface RoleAuditRow {
  readonly rolname: string;
  readonly kind: string;
  readonly rolsuper: boolean;
  readonly rolcreaterole: boolean;
  readonly rolcreatedb: boolean;
  readonly rolbypassrls: boolean;
  readonly rolreplication: boolean;
  readonly member_of: readonly string[] | null;
  readonly can_connect_here: boolean;
  readonly public_databases: readonly string[] | null;
  readonly connection_limit: number;
  readonly settings: readonly string[] | null;
}

/** Normalise a row; throws on a kind the query cannot produce. */
export function toAuditedRole(row: RoleAuditRow): AuditedRole {
  if (row.kind !== "gateway-login" && row.kind !== "job-role" && row.kind !== "job-member") {
    throw new Error(`role audit: unexpected kind '${row.kind}' for ${row.rolname}`);
  }
  return {
    rolname: row.rolname,
    kind: row.kind,
    rolsuper: row.rolsuper,
    rolcreaterole: row.rolcreaterole,
    rolcreatedb: row.rolcreatedb,
    rolbypassrls: row.rolbypassrls,
    rolreplication: row.rolreplication,
    memberOf: row.member_of ?? [],
    canConnectHere: row.can_connect_here,
    publicDatabases: row.public_databases ?? [],
    connectionLimit: row.connection_limit,
    settings: row.settings ?? [],
  };
}

/**
 * What public_role lacks of {@link PUBLIC_ROLE_LIMITS}, one line each. A
 * missing limit is a violation, not a warning: without it the visitor-facing
 * login may take every connection and any amount of server time from the
 * database all environments share (#763 H3).
 */
function publicRoleLimitProblems(role: AuditedRole): string[] {
  const fix =
    "set by cms_admin migration 0500 or packages/migrations/src/bootstrap.sh (self-hosted: `cms-provision upgrade` re-runs it)";
  const out: string[] = [];
  if (role.connectionLimit !== PUBLIC_ROLE_LIMITS.connectionLimit) {
    out.push(
      `${role.rolname} has CONNECTION LIMIT ${role.connectionLimit} (it must be ${PUBLIC_ROLE_LIMITS.connectionLimit}; ${fix})`,
    );
  }
  const actual = new Map(
    role.settings.map((s) => {
      const i = s.indexOf("=");
      return [s.slice(0, i), s.slice(i + 1)] as const;
    }),
  );
  for (const [name, value] of Object.entries(PUBLIC_ROLE_LIMITS.settings)) {
    if (actual.get(name) !== value) {
      out.push(
        `${role.rolname} has ${name} ${actual.has(name) ? `= ${actual.get(name)}` : "unset"} (it must be ${value}; ${fix})`,
      );
    }
  }
  return out;
}

/**
 * The physical public database `role` is the gateway login of, or null
 * (the former gateway_role).
 */
function ownPublicDatabase(role: string, names: InstallNames): string | null {
  for (const db of PUBLIC_DATABASES) {
    if (publicDatabaseLogin(names, db) === role) return physicalDatabaseName(names, db);
  }
  return null;
}

export interface RoleAuditResult {
  /** Isolation breaches: the run must fail. */
  readonly violations: readonly string[];
  /** Over-privilege that does not breach isolation on its own. */
  readonly warnings: readonly string[];
}

/** Judge the audited roles of the install `names`; see the file comment for the rules. */
export function evaluateRoleAudit(
  names: InstallNames,
  roles: readonly AuditedRole[],
): RoleAuditResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  const privileged = privilegedGroups(names);
  for (const role of roles) {
    const name = role.rolname;
    for (const [attr, has] of [
      ["SUPERUSER", role.rolsuper],
      ["BYPASSRLS", role.rolbypassrls],
      ["REPLICATION", role.rolreplication],
    ] as const) {
      if (has) violations.push(`${name} has the ${attr} attribute`);
    }
    if (role.kind === "gateway-login") {
      if (role.memberOf.length > 0) {
        violations.push(`${name} is a member of ${role.memberOf.join(", ")} (it must be of none)`);
      }
      if (role.canConnectHere) {
        violations.push(`${name} can connect to ${names.databases.admin}`);
      }
      // #1329 — each gateway login reaches its own public database only.
      const own = ownPublicDatabase(name, names);
      for (const db of role.publicDatabases) {
        if (db !== own) violations.push(`${name} can connect to ${db}`);
      }
      if (own !== null) violations.push(...publicRoleLimitProblems(role));
    } else {
      const groups = role.memberOf.filter((g) => privileged.includes(g));
      if (groups.length > 0) {
        violations.push(`${name} is a member of ${groups.join(", ")}`);
      }
    }
    const attrs = [
      ...(role.rolcreaterole ? ["CREATEROLE"] : []),
      ...(role.rolcreatedb ? ["CREATEDB"] : []),
    ];
    if (attrs.length > 0) {
      warnings.push(
        `${name} has ${attrs.join(" + ")} (migration 0278 could not drop it with the migration role's rights)`,
      );
    }
  }
  return { violations, warnings };
}

/**
 * Issue #635 — every privilege on a cms_admin object granted to a role the
 * public side logs in as, or to PUBLIC on a table, sequence or schema (which
 * every login inherits — extension-owned objects aside). Run on the
 * install's admin database. Columns, tables, sequences, schemas, functions
 * and default privileges are all covered; the public side must not be able
 * to read or write a single authoring object. The former `gateway_role`
 * (#635): wherever it still exists, it must hold nothing.
 */
export function crossDatabaseGrantsSql(installNames: InstallNames): string {
  const names = checked(installNames);
  return `
WITH grantees AS (
  SELECT oid, rolname::text AS rolname FROM pg_roles
   WHERE rolname IN (${sqlList(gatewayLoginRoles(names))})
  UNION ALL SELECT 0::oid, 'PUBLIC'
),
grants AS (
  SELECT g.rolname, 'table ' || c.oid::regclass::text AS object
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN grantees g ON g.oid = a.grantee
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     -- An extension's own objects (e.g. a stats view it grants to PUBLIC)
     -- are the extension's contract, not an application grant.
     AND NOT (g.rolname = 'PUBLIC' AND EXISTS (
       SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid AND d.deptype = 'e'))
  UNION ALL
  SELECT g.rolname, 'column ' || c.oid::regclass::text || '.' || att.attname::text
    FROM pg_attribute att
    JOIN pg_class c ON c.oid = att.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(att.attacl) a
    JOIN grantees g ON g.oid = a.grantee
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL
  SELECT g.rolname, 'schema ' || n.nspname::text
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(n.nspacl) a
    JOIN grantees g ON g.oid = a.grantee
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\\_%'
     AND NOT (g.rolname = 'PUBLIC' AND n.nspname = 'public')
  UNION ALL
  SELECT g.rolname, 'function ' || p.oid::regprocedure::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN grantees g ON g.oid = a.grantee
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND g.rolname <> 'PUBLIC'
  UNION ALL
  SELECT g.rolname, 'default privileges of ' || pg_get_userbyid(d.defaclrole)::text
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    JOIN grantees g ON g.oid = a.grantee
)
SELECT DISTINCT rolname, object FROM grants ORDER BY rolname, object
`;
}

/** A raw row of {@link crossDatabaseGrantsSql}. */
export interface CrossDatabaseGrantRow {
  readonly rolname: string;
  readonly object: string;
}

/**
 * Issue #1329 — the install's databases (admin and the public ones) every
 * login may CONNECT to through PUBLIC. Each must be closed: a PUBLIC
 * CONNECT would hand every login, the other environment's gateway and
 * (#1689) every other install's logins included, a way in. The database
 * ACLs are cluster-wide, so it runs on any database.
 */
export function publicConnectSql(installNames: InstallNames): string {
  const names = checked(installNames);
  return `
SELECT d.datname::text AS datname FROM pg_database d
 WHERE d.datname IN (${sqlList(installDatabases(names))})
   AND has_database_privilege('public', d.oid, 'CONNECT')
 ORDER BY 1
`;
}

/** The violation text for each database PUBLIC may connect to. */
export function publicConnectViolations(rows: readonly { datname: string }[]): string[] {
  return rows.map(
    (r) =>
      `PUBLIC may connect to ${r.datname} (every login could open it, the other environment's gateway and every other install's logins included; cms_admin migrations 0278 and 0530 revoke it)`,
  );
}

/** The violation text for each grant the public side holds on cms_admin. */
export function crossDatabaseGrantViolations(
  rows: readonly CrossDatabaseGrantRow[],
  names: InstallNames,
): string[] {
  return rows.map(
    (r) =>
      `${r.rolname} holds a privilege on ${names.databases.admin} ${r.object} (the public side must reach no authoring object)`,
  );
}

/**
 * Issue #1689 — the CTEs both cross-install checks share: the install's
 * roles and every role that is a member of one (the jobs' IAM logins, the
 * update agent), and the OTHER private databases on the server — neither
 * this install's, nor open to every login, nor one of the server's own
 * ({@link SERVER_DATABASES}). Only another install (or another tenant of the server) has
 * such a database, so a role that may connect to one belongs to it.
 */
function installScopeCtes(names: InstallNames): string {
  return `
membership(member, roleid) AS (
  SELECT member, roleid FROM pg_auth_members
  UNION
  SELECT m.member, a.roleid FROM membership m JOIN pg_auth_members a ON a.member = m.roleid
),
own_roles AS (
  SELECT oid FROM pg_roles WHERE rolname IN (${sqlList(installRoles(names))})
),
install_members AS (
  SELECT oid FROM own_roles
  UNION
  SELECT m.member FROM membership m JOIN own_roles o ON o.oid = m.roleid
),
other_databases AS MATERIALIZED (
  SELECT d.oid, d.datname FROM pg_database d
   WHERE d.datallowconn
     AND d.datname NOT IN (${sqlList(installDatabases(names))})
     AND d.datname NOT IN (${sqlList(SERVER_DATABASES)})
     AND NOT has_database_privilege('public', d.oid, 'CONNECT')
)`;
}

/**
 * Issue #1689 — every role of the install (and member of one) that may
 * connect to another install's database (see {@link installScopeCtes}).
 * Superusers reach every database by definition and are no install's role.
 * The database ACLs are cluster-wide, so it runs on any database.
 */
export function crossInstallConnectSql(installNames: InstallNames): string {
  const names = checked(installNames);
  return `
WITH RECURSIVE ${installScopeCtes(names)}
SELECT r.rolname::text AS rolname, d.datname::text AS datname
  FROM install_members i
  JOIN pg_roles r ON r.oid = i.oid
  CROSS JOIN other_databases d
 WHERE NOT r.rolsuper
   AND has_database_privilege(r.oid, d.oid, 'CONNECT')
 ORDER BY 1, 2
`;
}

/** A raw row of {@link crossInstallConnectSql}. */
export interface CrossInstallConnectRow {
  readonly rolname: string;
  readonly datname: string;
}

/** The violation text for each other install's database a role of this install may open. */
export function crossInstallConnectViolations(rows: readonly CrossInstallConnectRow[]): string[] {
  return rows.map(
    (r) =>
      `${r.rolname} can connect to ${r.datname}, a database of another install (#1689: an install's roles reach its own databases only; revoke the CONNECT or the membership that carries it)`,
  );
}

/**
 * Issue #1689 — every reference the CURRENT database holds to a role of
 * another install: an object it owns, a privilege granted to it (tables,
 * columns, sequences, schemas, functions, types, default privileges), a
 * row-level policy that names it, and its privileges on or ownership of
 * the database itself. `pg_shdepend` records each of these for every role
 * but the bootstrap superuser, so no object kind is left out by omission.
 * A role is another install's when it is not this install's (nor a member
 * of one), not a superuser, and may connect to another private database
 * ({@link installScopeCtes}). Run on each of the install's databases.
 */
export function foreignReferencesSql(installNames: InstallNames): string {
  const names = checked(installNames);
  return `
WITH RECURSIVE ${installScopeCtes(names)},
references_here(role_oid, kind, classid, objid, objsubid) AS (
  SELECT d.refobjid, d.deptype::text, d.classid, d.objid, d.objsubid
    FROM pg_shdepend d
   WHERE d.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND d.refclassid = 'pg_authid'::regclass
  UNION ALL
  SELECT a.grantee, 'database-acl', 'pg_database'::regclass, db.oid, 0
    FROM pg_database db CROSS JOIN LATERAL aclexplode(db.datacl) a
   WHERE db.datname = current_database() AND a.grantee <> 0
  UNION ALL
  SELECT db.datdba, 'o', 'pg_database'::regclass, db.oid, 0
    FROM pg_database db WHERE db.datname = current_database()
),
foreign_roles AS MATERIALIZED (
  SELECT r.oid, r.rolname
    FROM (SELECT DISTINCT role_oid FROM references_here) c
    JOIN pg_roles r ON r.oid = c.role_oid
   WHERE NOT r.rolsuper
     AND r.oid NOT IN (SELECT oid FROM install_members)
     AND EXISTS (SELECT 1 FROM other_databases o
                  WHERE has_database_privilege(r.oid, o.oid, 'CONNECT'))
)
SELECT DISTINCT f.rolname::text AS rolname,
       CASE x.kind
         WHEN 'o' THEN 'owns '
         WHEN 'a' THEN 'holds a privilege on '
         WHEN 'database-acl' THEN 'holds a privilege on '
         WHEN 'r' THEN 'is named by '
         WHEN 'i' THEN 'holds an initial privilege on '
         ELSE 'is referenced by '
       END || pg_describe_object(x.classid, x.objid, x.objsubid) AS what
  FROM references_here x JOIN foreign_roles f ON f.oid = x.role_oid
 ORDER BY 1, 2
`;
}

/** A raw row of {@link foreignReferencesSql}. */
export interface ForeignReferenceRow {
  readonly rolname: string;
  readonly what: string;
}

/**
 * Fail (throw) when the current database — `database` of the install
 * `names` — holds anything of another install's role
 * ({@link foreignReferencesSql}, #1689). Run by migrate.ts after every
 * migration run, connected to that database.
 */
export async function assertNoForeignReferences(
  sql: AuditQuery,
  database: LogicalDatabase,
  names: InstallNames,
): Promise<void> {
  const rows = (await sql.unsafe(foreignReferencesSql(names))) as ForeignReferenceRow[];
  if (rows.length === 0) return;
  const physical = physicalDatabaseName(names, database);
  throw new Error(
    roleAuditError({
      violations: rows.map(
        (r) =>
          `${r.rolname}, a role of another install, ${r.what} in ${physical} (#1689: an install's databases name its own roles only; revoke the grant, or change the owner or the policy to this install's role)`,
      ),
      warnings: [],
    }),
  );
}

/**
 * Issue #635 — run on each public database (cms_public and, since #1329,
 * cms_public_staging): nothing there may reach another database.
 * dblink or postgres_fdw, a foreign server, or a user mapping is a bridge a
 * compromised public side could use to reach cms_admin.
 */
export const PUBLIC_DATABASE_BRIDGES_SQL = `
SELECT 'extension ' || extname::text AS bridge FROM pg_extension
 WHERE extname IN ('dblink', 'postgres_fdw')
UNION ALL SELECT 'foreign data wrapper ' || fdwname::text FROM pg_foreign_data_wrapper
UNION ALL SELECT 'foreign server ' || srvname::text FROM pg_foreign_server
UNION ALL SELECT 'user mapping for ' || usename::text FROM pg_user_mappings
ORDER BY 1
`;

/**
 * Fail (throw) when the public database `database` holds a bridge to
 * another database. Run by migrate.ts after every public migration run.
 */
export async function assertPublicDatabaseIsolated(
  sql: AuditQuery,
  database: PublicDatabase,
  names: InstallNames,
): Promise<void> {
  const rows = (await sql.unsafe(PUBLIC_DATABASE_BRIDGES_SQL)) as { bridge: string }[];
  if (rows.length === 0) return;
  const physical = physicalDatabaseName(names, database);
  throw new Error(
    roleAuditError({
      violations: rows.map((r) => `${physical} has a ${r.bridge}, a bridge to other databases`),
      warnings: [],
    }),
  );
}

/**
 * Issue #1329 — every privilege or row-level policy in the current public
 * database that names the OTHER environment's gateway login: in cms_public
 * nothing may name public_staging_role, in cms_public_staging nothing
 * public_role. The cms_public migrations are written for public_role; the
 * staging run retargets them (runner.ts `installNameTokens`), and this
 * proves that it held.
 */
export function foreignLoginGrantsSql(
  installNames: InstallNames,
  database: PublicDatabase,
): string {
  const names = checked(installNames);
  const own = publicDatabaseLogin(names, database);
  const list = sqlList(visitorLoginRoles(names).filter((r) => r !== own));
  return `
WITH grantees AS (
  SELECT oid, rolname::text AS rolname FROM pg_roles WHERE rolname IN (${list})
)
SELECT g.rolname, 'table ' || c.oid::regclass::text AS object
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  JOIN grantees g ON g.oid = a.grantee
UNION
SELECT g.rolname, 'column ' || c.oid::regclass::text || '.' || att.attname::text
  FROM pg_attribute att
  JOIN pg_class c ON c.oid = att.attrelid
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  JOIN grantees g ON g.oid = a.grantee
UNION
SELECT g.rolname, 'schema ' || n.nspname::text
  FROM pg_namespace n
  CROSS JOIN LATERAL aclexplode(n.nspacl) a
  JOIN grantees g ON g.oid = a.grantee
UNION
SELECT g.rolname, 'function ' || p.oid::regprocedure::text
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(p.proacl) a
  JOIN grantees g ON g.oid = a.grantee
UNION
SELECT g.rolname, 'policy ' || pol.polname::text || ' on ' || pol.polrelid::regclass::text
  FROM pg_policy pol
  JOIN grantees g ON g.oid = ANY(pol.polroles)
UNION
SELECT g.rolname, 'default privileges of ' || pg_get_userbyid(d.defaclrole)::text
  FROM pg_default_acl d
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  JOIN grantees g ON g.oid = a.grantee
ORDER BY 1, 2
`;
}

/**
 * Fail (throw) when the public database `database` grants anything to the
 * other environment's gateway login (#1329). Run by migrate.ts after every
 * migration run of a public database, connected to that database.
 */
export async function assertPublicDatabaseOwnsItsLogin(
  sql: AuditQuery,
  database: PublicDatabase,
  names: InstallNames,
): Promise<void> {
  const rows = (await sql.unsafe(
    foreignLoginGrantsSql(names, database),
  )) as CrossDatabaseGrantRow[];
  if (rows.length === 0) return;
  const physical = physicalDatabaseName(names, database);
  throw new Error(
    roleAuditError({
      violations: rows.map(
        (r) =>
          `${r.rolname} holds ${r.object} in ${physical} (only ${publicDatabaseLogin(names, database)} may: the other environment's gateway must reach nothing here)`,
      ),
      warnings: [],
    }),
  );
}

/** What the operator does about a violation; part of the error message. */
export const ROLE_AUDIT_NEXT_STEP =
  "On GCP run `cms-provision upgrade` (it revokes the Cloud SQL Admin API's role memberships from public_role, then migrates again); on a self-hosted install run `cms-provision up`; on a shared Postgres server, fix the grant the violation names as the server's administrator (docs/dev/shared-postgres.md). Do not roll any service until this check passes.";

/**
 * Format a failed audit as one error message: every violation, then the
 * next step.
 */
export function roleAuditError(result: RoleAuditResult): string {
  return [
    `Database role isolation check failed (issues #633, #635, #1689; CLAUDE.md §2):`,
    ...result.violations.map((v) => `  - ${v}`),
    ROLE_AUDIT_NEXT_STEP,
  ].join("\n");
}

/** The minimal query surface the audit needs (a Bun SQL client fits). */
export interface AuditQuery {
  unsafe(query: string): Promise<unknown>;
}

/**
 * Run the audit on a connection to the install's admin database. Throws
 * with {@link roleAuditError} on a violation; returns the result (warnings
 * included) otherwise.
 */
export async function assertRoleIsolation(
  sql: AuditQuery,
  names: InstallNames,
): Promise<RoleAuditResult> {
  const rows = (await sql.unsafe(roleAuditSql(names))) as RoleAuditRow[];
  const grants = (await sql.unsafe(crossDatabaseGrantsSql(names))) as CrossDatabaseGrantRow[];
  const openDatabases = (await sql.unsafe(publicConnectSql(names))) as { datname: string }[];
  const crossInstall = (await sql.unsafe(
    crossInstallConnectSql(names),
  )) as CrossInstallConnectRow[];
  const roles = evaluateRoleAudit(names, rows.map(toAuditedRole));
  const result: RoleAuditResult = {
    violations: [
      ...roles.violations,
      ...crossDatabaseGrantViolations(grants, names),
      ...publicConnectViolations(openDatabases),
      ...crossInstallConnectViolations(crossInstall),
    ],
    warnings: roles.warnings,
  };
  if (result.violations.length > 0) throw new Error(roleAuditError(result));
  return result;
}
