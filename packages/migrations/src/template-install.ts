// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1689 — create an install's databases on a shared Postgres server
 * by copying a template install, in seconds instead of a full migration
 * run (measured: 2.6–7 s against 15–90 s for bootstrap + every migration).
 *
 * The template is an install like any other — bootstrapped with its own
 * name map (bootstrap.sh with CAELO_INSTALL_NAMES) and migrated, but never
 * booted: nothing install-specific (an Owner, a secret, content) lives in
 * it, and no session may be connected to it while a copy runs. For the new
 * install {@link installFromTemplate}:
 *
 *   1. creates its roles with the template roles' attributes (login,
 *      inherit, connection limit, settings) and the memberships between
 *      them, nothing more (no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION
 *      or BYPASSRLS);
 *   2. takes a CHECKPOINT (a copy of a database with dirty buffers is up to
 *      15× slower), then copies each database with `CREATE DATABASE …
 *      TEMPLATE … OWNER <new admin role>` (the default WAL_LOG strategy;
 *      FILE_COPY measured slower) and closes it to PUBLIC at once;
 *   3. rebinds each copy to the new roles object by object
 *      (template-rebind.ts — never REASSIGN OWNED or DROP OWNED);
 *   4. grants CONNECT and the other database privileges the template's
 *      roles held on the template's databases to the new roles, and
 *      applies the template's per-database settings (`ALTER DATABASE …
 *      SET`): neither is part of a copy;
 *   5. draws every secret a migration drew at random for the template
 *      anew (cookie and unsubscribe-link signing keys, template-secrets.ts)
 *      and republishes the gateways' projection from the copy, so no two
 *      installs share a signing key;
 *   6. refuses the result unless no reference to a template role is left,
 *      no function body names the template's roles or databases, and the
 *      role audit migrate.ts runs after every migration passes for the new
 *      install (role-audit.ts) — the same bar as a freshly migrated one.
 *
 * Two copies may run at once: each touches only its own new roles and
 * databases (CREATE DATABASE only reads the template), and nothing here
 * connects to a template database. A copy that fails is removed again
 * (its databases, then its roles) and the error names why.
 *
 * Needs a superuser connection (the provider's own, never an install's):
 * it creates roles and databases and changes owners of objects it does not
 * own. The CLI is install-from-template.ts; docs/dev/shared-postgres.md.
 */

import {
  type InstallNames,
  installDatabases,
  installRoles,
  type LogicalDatabase,
  parseInstallNames,
  physicalDatabaseName,
} from "@caelo-cms/shared";
import type { SQL } from "bun";
import { publishProjectionOver } from "./projection-publish.js";
import { assertNoRlsPolicyDrift } from "./rls.js";
import {
  assertNoForeignReferences,
  assertPublicDatabaseIsolated,
  assertPublicDatabaseOwnsItsLogin,
  assertRoleIsolation,
  type PUBLIC_DATABASES,
} from "./role-audit.js";
import {
  REBIND_MAP_SETTING,
  REBIND_SQL,
  staleFunctionBodiesSql,
  templateReferencesSql,
} from "./template-rebind.js";
import { drawInstallSecrets } from "./template-secrets.js";

export { INSTALL_SECRETS, type InstallSecret } from "./template-secrets.js";

/** Opens a superuser connection to the named database (the caller owns closing it). */
export type ConnectAs = (database: string) => SQL;

/** The passwords of the new install's three logins. */
export interface InstallPasswords {
  readonly admin: string;
  readonly public: string;
  readonly publicStaging: string;
}

export interface InstallFromTemplateOptions {
  /** A superuser connection to any database (the provider's maintenance database). */
  readonly connect: ConnectAs;
  /** The server's maintenance database, the one {@link connect} opens for shared catalogs. */
  readonly maintenanceDatabase: string;
  /** The template install's names (its databases are copied). */
  readonly template: InstallNames;
  /** The new install's names; none may exist on the server yet. */
  readonly target: InstallNames;
  readonly passwords: InstallPasswords;
  /**
   * The new admin login's CONNECTION LIMIT, so one install cannot take
   * every connection of the shared server; the template admin role's own
   * limit when not given.
   */
  readonly adminConnectionLimit?: number;
}

/** What a copy did, with its timings in milliseconds. */
export interface InstallFromTemplateReport {
  readonly databases: readonly string[];
  readonly roles: readonly string[];
  readonly checkpoint: "done" | "not permitted";
  readonly ms: { readonly roles: number; readonly copy: number; readonly rebind: number };
}

/** The logical databases, in copy order. */
const LOGICAL_DATABASES: readonly LogicalDatabase[] = [
  "cms_admin",
  "cms_public",
  "cms_public_staging",
];

/** A SQL string literal (standard_conforming_strings, the default since 9.1). */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A role or database name; the maps are validated, this keeps every statement honest. */
function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a role or database name`);
  return `"${name}"`;
}

/** `{ templateRole: newRole }` for every role slot. */
function roleMap(template: InstallNames, target: InstallNames): Map<string, string> {
  const map = new Map<string, string>();
  for (const slot of Object.keys(template.roles) as (keyof InstallNames["roles"])[]) {
    map.set(template.roles[slot], target.roles[slot]);
  }
  return map;
}

interface TemplateRole {
  readonly rolname: string;
  readonly rolcanlogin: boolean;
  readonly rolinherit: boolean;
  readonly rolconnlimit: number;
  readonly rolconfig: readonly string[] | null;
}

/** `name=value` (pg_roles.rolconfig, pg_db_role_setting.setconfig) as a SET clause. */
function setClause(entry: string): string {
  const i = entry.indexOf("=");
  const name = entry.slice(0, i);
  if (i <= 0 || !/^[a-z_][a-z0-9_.]*$/.test(name)) {
    throw new Error(`template setting "${entry}" is not name=value`);
  }
  return `SET ${name} = ${literal(entry.slice(i + 1))}`;
}

/** Refuse a target that clashes with the template or with anything on the server. */
async function assertFreshTarget(
  admin: SQL,
  template: InstallNames,
  target: InstallNames,
): Promise<void> {
  const templateNames = new Set([...installRoles(template), ...installDatabases(template)]);
  const clash = [...installRoles(target), ...installDatabases(target)].filter((n) =>
    templateNames.has(n),
  );
  if (clash.length > 0) {
    throw new Error(
      `install from template: the new install names ${clash.join(", ")} like the template (#1689: every install has names of its own)`,
    );
  }
  const taken = (await admin.unsafe(`
    SELECT rolname::text AS name FROM pg_roles WHERE rolname IN (${installRoles(target).map(literal).join(", ")})
    UNION ALL
    SELECT datname::text FROM pg_database WHERE datname IN (${installDatabases(target).map(literal).join(", ")})
  `)) as { name: string }[];
  if (taken.length > 0) {
    throw new Error(
      `install from template: ${taken.map((t) => t.name).join(", ")} already exist on the server; pick other names or remove the half-made install first`,
    );
  }
  const missing = (await admin.unsafe(`
    SELECT d FROM unnest(ARRAY[${installDatabases(template).map(literal).join(", ")}]) d
     WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d)
  `)) as { d: string }[];
  if (missing.length > 0) {
    throw new Error(
      `install from template: the template's ${missing.map((m) => m.d).join(", ")} do not exist; bootstrap and migrate the template first (docs/dev/shared-postgres.md)`,
    );
  }
}

/** Step 1 — the new roles, with the template roles' attributes and memberships. */
async function createRoles(admin: SQL, opts: InstallFromTemplateOptions): Promise<string[]> {
  const map = roleMap(opts.template, opts.target);
  const rows = (await admin.unsafe(`
    SELECT rolname::text, rolcanlogin, rolinherit, rolconnlimit, rolconfig::text[] AS rolconfig
      FROM pg_roles WHERE rolname IN (${[...map.keys()].map(literal).join(", ")})
  `)) as TemplateRole[];
  const password = new Map([
    [opts.template.roles.admin, opts.passwords.admin],
    [opts.template.roles.public, opts.passwords.public],
    [opts.template.roles.publicStaging, opts.passwords.publicStaging],
  ]);
  const created: string[] = [];
  await admin.begin(async (tx) => {
    // CREATE ROLE takes the password in its text (no bind parameters for
    // utility statements); keep that text out of the server log.
    await tx.unsafe("SET LOCAL log_statement = 'none'");
    await tx.unsafe("SET LOCAL log_min_duration_statement = -1");
    await tx.unsafe("SET LOCAL log_min_error_statement = 'panic'");
    for (const role of rows) {
      const name = map.get(role.rolname);
      if (name === undefined) continue;
      const pw = password.get(role.rolname);
      if (role.rolcanlogin && pw === undefined) {
        throw new Error(
          `install from template: the template role ${role.rolname} can log in, but it is not one of the three logins a password is given for`,
        );
      }
      const limit =
        role.rolname === opts.template.roles.admin && opts.adminConnectionLimit !== undefined
          ? opts.adminConnectionLimit
          : role.rolconnlimit;
      await tx.unsafe(
        `CREATE ROLE ${ident(name)} ${role.rolcanlogin ? "LOGIN" : "NOLOGIN"} ${role.rolinherit ? "INHERIT" : "NOINHERIT"} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${Number(limit)}${role.rolcanlogin ? ` PASSWORD ${literal(pw ?? "")}` : ""}`,
      );
      for (const entry of role.rolconfig ?? []) {
        await tx.unsafe(`ALTER ROLE ${ident(name)} ${setClause(entry)}`);
      }
      created.push(name);
    }
    const memberships = (await tx.unsafe(`
      SELECT r.rolname::text AS role, m.rolname::text AS member,
             a.admin_option, a.inherit_option, a.set_option
        FROM pg_auth_members a
        JOIN pg_roles r ON r.oid = a.roleid
        JOIN pg_roles m ON m.oid = a.member
       WHERE r.rolname IN (${[...map.keys()].map(literal).join(", ")})
         AND m.rolname IN (${[...map.keys()].map(literal).join(", ")})
    `)) as {
      role: string;
      member: string;
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }[];
    for (const g of memberships) {
      const role = map.get(g.role);
      const member = map.get(g.member);
      if (!role || !member) continue;
      await tx.unsafe(
        `GRANT ${ident(role)} TO ${ident(member)} WITH ADMIN ${g.admin_option}, INHERIT ${g.inherit_option}, SET ${g.set_option}`,
      );
    }
  });
  return created;
}

/**
 * Step 2 — copy one database and close it to every login at once.
 * `created` learns the database only once it exists, so a failed copy
 * never removes a database of the same name that someone else made.
 */
async function copyDatabase(
  admin: SQL,
  from: string,
  to: string,
  owner: string,
  created: string[],
): Promise<void> {
  await admin.unsafe(`CREATE DATABASE ${ident(to)} TEMPLATE ${ident(from)} OWNER ${ident(owner)}`);
  created.push(to);
  await admin.unsafe(`REVOKE ALL ON DATABASE ${ident(to)} FROM PUBLIC`);
}

/** Step 3 — rebind one copy; throws listing whatever still names the template. */
async function rebindDatabase(
  connect: ConnectAs,
  database: string,
  map: Map<string, string>,
  template: InstallNames,
): Promise<void> {
  const db = connect(database);
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = 0");
      await tx.unsafe("SET LOCAL lock_timeout = 0");
      await tx`SELECT set_config(${REBIND_MAP_SETTING}, ${JSON.stringify(Object.fromEntries(map))}, true)`;
      await tx.unsafe(REBIND_SQL);
      const left = (await tx.unsafe(templateReferencesSql([...map.keys()]))) as {
        reference: string;
      }[];
      const stale = (await tx.unsafe(
        staleFunctionBodiesSql([...installRoles(template), ...installDatabases(template)]),
      )) as { routine: string }[];
      const problems = [
        ...left.map((l) => l.reference),
        ...stale.map(
          (s) => `function ${s.routine} names the template's roles or databases in its body`,
        ),
      ];
      if (problems.length > 0) {
        throw new Error(
          `install from template: ${database} still names the template after the rebind (#1689):\n${problems.map((p) => `  - ${p}`).join("\n")}\nAn extension the template's admin role owns cannot be moved: recreate the template with bootstrap.sh, which creates pg_trgm as the superuser. Anything else is a kind of object the rebind does not move yet (packages/migrations/src/template-rebind.ts).`,
        );
      }
    });
  } finally {
    await db.end();
  }
}

/** Step 4 — the template databases' privileges and settings, for the copy. */
async function copyDatabaseAclAndSettings(
  admin: SQL,
  from: string,
  to: string,
  map: Map<string, string>,
): Promise<void> {
  const acl = (await admin.unsafe(`
    SELECT coalesce(g.rolname::text, 'PUBLIC') AS grantee, a.privilege_type AS priv, a.is_grantable
      FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
      LEFT JOIN pg_roles g ON g.oid = a.grantee
     WHERE d.datname = ${literal(from)}
  `)) as { grantee: string; priv: string; is_grantable: boolean }[];
  for (const entry of acl) {
    const role = map.get(entry.grantee);
    if (role === undefined) {
      throw new Error(
        `install from template: the template database ${from} grants ${entry.priv} to ${entry.grantee}, which is not one of the template's roles; close it (docs/dev/shared-postgres.md) before copying`,
      );
    }
    await admin.unsafe(
      `GRANT ${entry.priv} ON DATABASE ${ident(to)} TO ${ident(role)}${entry.is_grantable ? " WITH GRANT OPTION" : ""}`,
    );
  }
  const settings = (await admin.unsafe(`
    SELECT coalesce(g.rolname::text, '') AS role, s.setconfig::text[] AS config
      FROM pg_db_role_setting s
      JOIN pg_database d ON d.oid = s.setdatabase
      LEFT JOIN pg_roles g ON g.oid = s.setrole
     WHERE d.datname = ${literal(from)}
  `)) as { role: string; config: string[] }[];
  for (const s of settings) {
    const role = s.role === "" ? null : map.get(s.role);
    if (role === undefined) {
      throw new Error(
        `install from template: the template database ${from} has settings for ${s.role}, which is not one of the template's roles`,
      );
    }
    for (const entry of s.config) {
      await admin.unsafe(
        role === null
          ? `ALTER DATABASE ${ident(to)} ${setClause(entry)}`
          : `ALTER ROLE ${ident(role)} IN DATABASE ${ident(to)} ${setClause(entry)}`,
      );
    }
  }
}

/**
 * Step 5 — the copy's own secrets (template-secrets.ts): every value a
 * migration drew at random for the template is drawn again, and the
 * gateways' projection is published from the copy's admin database, so
 * neither public database keeps the template's signing keys.
 */
async function drawSecretsAndRepublish(connect: ConnectAs, target: InstallNames): Promise<void> {
  const clients = {
    admin: connect(target.databases.admin),
    live: connect(target.databases.public),
    staging: connect(target.databases.publicStaging),
  };
  try {
    await drawInstallSecrets(clients.admin);
    await publishProjectionOver(clients);
  } finally {
    await Promise.all([clients.admin.end(), clients.live.end(), clients.staging.end()]);
  }
}

/** Step 6 — the checks migrate.ts runs after every migration, for the new install. */
async function auditNewInstall(connect: ConnectAs, target: InstallNames): Promise<void> {
  for (const logical of LOGICAL_DATABASES) {
    const db = connect(physicalDatabaseName(target, logical));
    try {
      await assertNoRlsPolicyDrift(db);
      await assertNoForeignReferences(db, logical, target);
      if (logical === "cms_admin") {
        await assertRoleIsolation(db, target);
      } else {
        const pub = logical as (typeof PUBLIC_DATABASES)[number];
        await assertPublicDatabaseIsolated(db, pub, target);
        await assertPublicDatabaseOwnsItsLogin(db, pub, target);
      }
    } finally {
      await db.end();
    }
  }
}

/** Remove whatever a failed copy created: its databases first (they hold its roles' objects). */
async function removeHalfMadeInstall(
  admin: SQL,
  databases: readonly string[],
  roles: readonly string[],
): Promise<void> {
  for (const db of databases) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${ident(db)} WITH (FORCE)`);
  }
  for (const role of [...roles].reverse()) {
    await admin.unsafe(`DROP ROLE IF EXISTS ${ident(role)}`);
  }
}

/**
 * Create the install `opts.target` on the template's server from a copy of
 * the template install (see the file comment for the steps).
 *
 * @throws when a target name exists or equals a template name, the template
 *   is incomplete or in use, or the copy fails a check; nothing of the new
 *   install is left behind then
 */
export async function installFromTemplate(
  opts: InstallFromTemplateOptions,
): Promise<InstallFromTemplateReport> {
  const template = parseInstallNames(opts.template, "the template's install names");
  const target = parseInstallNames(opts.target, "the new install's names");
  if (
    opts.adminConnectionLimit !== undefined &&
    (!Number.isInteger(opts.adminConnectionLimit) || opts.adminConnectionLimit < 1)
  ) {
    throw new Error(
      "install from template: the admin connection limit must be a whole number above 0",
    );
  }
  const map = roleMap(template, target);
  const admin = opts.connect(opts.maintenanceDatabase);
  const createdDatabases: string[] = [];
  let createdRoles: string[] = [];
  try {
    const [server] = (await admin.unsafe(
      "SELECT current_setting('server_version_num')::int AS v, current_setting('standard_conforming_strings') AS scs, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su",
    )) as { v: number; scs: string; su: boolean }[];
    if (!server?.su) {
      throw new Error("install from template: connect as a superuser of the server (#1689)");
    }
    if (server.v < 160000) {
      throw new Error(
        "install from template: needs PostgreSQL 16 or later (role membership options)",
      );
    }
    // `literal` doubles quotes only, which is the whole escaping exactly
    // while backslashes are plain characters.
    if (server.scs !== "on") {
      throw new Error("install from template: needs standard_conforming_strings = on");
    }
    await assertFreshTarget(admin, template, target);

    let t = performance.now();
    createdRoles = await createRoles(admin, { ...opts, template, target });
    const rolesMs = performance.now() - t;

    t = performance.now();
    let checkpoint: InstallFromTemplateReport["checkpoint"] = "done";
    try {
      await admin.unsafe("CHECKPOINT");
    } catch (e) {
      // Only a speed-up: a copy of dirty buffers is slower, not different.
      if (!/permission denied|must be superuser|pg_checkpoint/i.test(String(e))) throw e;
      checkpoint = "not permitted";
    }
    for (const logical of LOGICAL_DATABASES) {
      await copyDatabase(
        admin,
        physicalDatabaseName(template, logical),
        physicalDatabaseName(target, logical),
        target.roles.admin,
        createdDatabases,
      );
    }
    const copyMs = performance.now() - t;

    t = performance.now();
    await Promise.all(
      LOGICAL_DATABASES.map((logical) =>
        rebindDatabase(opts.connect, physicalDatabaseName(target, logical), map, template),
      ),
    );
    for (const logical of LOGICAL_DATABASES) {
      await copyDatabaseAclAndSettings(
        admin,
        physicalDatabaseName(template, logical),
        physicalDatabaseName(target, logical),
        map,
      );
    }
    await drawSecretsAndRepublish(opts.connect, target);
    await auditNewInstall(opts.connect, target);
    const rebindMs = performance.now() - t;

    return {
      databases: createdDatabases,
      roles: createdRoles,
      checkpoint,
      ms: { roles: rolesMs, copy: copyMs, rebind: rebindMs },
    };
  } catch (e) {
    await removeHalfMadeInstall(admin, createdDatabases, createdRoles);
    throw e;
  } finally {
    await admin.end();
  }
}
