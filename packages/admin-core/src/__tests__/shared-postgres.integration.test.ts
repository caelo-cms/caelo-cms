// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1689 — several installs on one Postgres server, against the real
 * thing. Install A is the default install every suite uses; install B is
 * bootstrapped (bootstrap.sh with its name map) and migrated (migrate.ts,
 * with every audit) here, then copied twice at once into C1 and C2
 * (install-from-template.ts). Proves:
 *
 *   - both installs migrate fully on one server, each audit passing;
 *   - no login of A connects to a database of B and no login of B to one
 *     of A (so neither reads nor writes the other's data — Postgres has no
 *     cross-database query without a bridge, which the audit refuses), and
 *     no role of one may SET ROLE to a role of the other;
 *   - a plugin provisioned for B grants to B's roles only;
 *   - the role audit fails on a cross-install grant, CONNECT, policy or
 *     role membership (with or without INHERIT);
 *   - a template copy has exactly the privilege fingerprint of the freshly
 *     migrated template, two copies at once both succeed, each copy has
 *     signing secrets of its own (also in its public databases), a copy never
 *     overwrites an existing install, and the copy migrates and audits
 *     clean afterwards.
 *
 * Needs the superuser (POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_PORT,
 * as role-audit.integration.test.ts) and psql on PATH (bootstrap.sh). Every
 * role and database it creates is dropped again.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoForeignReferences,
  assertPublicDatabaseOwnsItsLogin,
  assertRoleIsolation,
} from "@caelo-cms/migrations/role-audit";
import { INSTALL_SECRETS, installFromTemplate } from "@caelo-cms/migrations/template-install";
import { provisionPluginPublicSchemas } from "@caelo-cms/plugin-host";
import { adminGrantTarget, adminSchemaFromSpec } from "@caelo-cms/plugin-sandbox";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import {
  DEFAULT_INSTALL_NAMES,
  type InstallNames,
  installDatabases,
  installNamesEnv,
  installRoles,
  type LogicalDatabase,
  parseInstallNames,
  physicalDatabaseName,
  prefixedInstallNames,
} from "@caelo-cms/shared";
import { SQL } from "bun";

const env = process.env;
const missing = ["POSTGRES_USER", "POSTGRES_PORT", "ADMIN_DATABASE_URL"].filter((n) => !env[n]);
if (missing.length > 0) throw new Error(`${missing.join(", ")} required (see .env.example)`);

/** packages/migrations, where bootstrap.sh and migrate.ts live. */
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");
const HOST = new URL(env.ADMIN_DATABASE_URL as string).hostname;
const PASSWORDS = { admin: "b-admin-pw", public: "b-public-pw", publicStaging: "b-staging-pw" };
/**
 * Install B's admin login is bounded, as on a shared server: its migration
 * runs, its copies' (which take the template's limit) and the adapters
 * below must all fit under it.
 */
const ADMIN_CONNECTION_LIMIT = 12;
const A = DEFAULT_INSTALL_NAMES;
const B = prefixedInstallNames("ci1689b");
const C1 = prefixedInstallNames("ci1689c1");
const C2 = prefixedInstallNames("ci1689c2");
/** Copied with a probe on every CREATE DATABASE (a login of A tries to get in). */
const C3 = prefixedInstallNames("ci1689c3");
/** Bootstrapped with a probe on every CREATE DATABASE, never migrated. */
const D = prefixedInstallNames("ci1689d");
const OURS = [B, C1, C2, C3, D];
const LOGICAL: readonly LogicalDatabase[] = ["cms_admin", "cms_public", "cms_public_staging"];

/** A URL on this server for `user` (password `password`, or the superuser's) on `database`. */
function url(
  database: string,
  user = env.POSTGRES_USER as string,
  password = env.POSTGRES_PASSWORD,
): string {
  const u = new URL(`postgres://${HOST}/${database}`);
  u.port = env.POSTGRES_PORT as string;
  u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** Install A's three logins, from the suite's own URLs. */
function loginsOfA(): { user: string; password: string }[] {
  return ["ADMIN_DATABASE_URL", "PUBLIC_DATABASE_URL", "PUBLIC_STAGING_DATABASE_URL"].map((v) => {
    const u = new URL(env[v] as string);
    return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  });
}

/** Install `names`' three logins with the test passwords. */
function loginsOf(names: InstallNames): { user: string; password: string }[] {
  return [
    { user: names.roles.admin, password: PASSWORDS.admin },
    { user: names.roles.public, password: PASSWORDS.public },
    { user: names.roles.publicStaging, password: PASSWORDS.publicStaging },
  ];
}

/**
 * Whether a login may open `database` at all: Postgres' CONNECT privilege,
 * and whether the database accepts connections (ALLOW_CONNECTIONS).
 */
async function canConnect(user: string, password: string, database: string): Promise<boolean> {
  const sql = new SQL(url(database, user, password), { max: 1 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch (e) {
    if (/permission denied for database|is not currently accepting connections/i.test(String(e))) {
      return false;
    }
    throw e;
  } finally {
    await sql.end();
  }
}

/** Run a command with the superuser's psql env and `extra`; throws with its output on failure. */
async function run(cmd: string[], extra: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: MIGRATIONS,
    env: {
      PATH: env.PATH ?? "",
      HOME: env.HOME ?? "",
      PGHOST: HOST,
      PGPORT: env.POSTGRES_PORT as string,
      PGPASSWORD: env.POSTGRES_PASSWORD ?? "",
      POSTGRES_USER: env.POSTGRES_USER as string,
      POSTGRES_DB: "postgres",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}:\n${out}\n${err}`);
}

/** The env migrate.ts takes for the install `names`. */
function migrateEnv(names: InstallNames): Record<string, string> {
  const d = names.databases;
  const admin = (db: string) => url(db, names.roles.admin, PASSWORDS.admin);
  return {
    ...installNamesEnv(names),
    ADMIN_DATABASE_URL: admin(d.admin),
    PUBLIC_ADMIN_DATABASE_URL: admin(d.public),
    PUBLIC_STAGING_ADMIN_DATABASE_URL: admin(d.publicStaging),
  };
}

async function migrate(names: InstallNames): Promise<void> {
  for (const target of ["admin", "public", "public-staging"]) {
    await run(["bun", "run", "src/migrate.ts", target], migrateEnv(names));
  }
}

/** Drop every database and role of `names` (a test install), whatever exists of it. */
async function dropInstall(su: SQL, names: InstallNames): Promise<void> {
  for (const db of installDatabases(names)) {
    await su.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  }
  for (const role of [...installRoles(names)].reverse()) {
    await su.unsafe(`DROP ROLE IF EXISTS "${role}"`);
  }
}

/**
 * Every owner, privilege, policy and database-level grant or setting of the
 * install `names`, with its role and database names replaced by their
 * slot, so two installs of the same schema compare equal.
 */
async function fingerprint(names: InstallNames): Promise<string[]> {
  const slots = new Map<string, string>([
    ...Object.entries(names.roles).map(([k, v]) => [v, `<role:${k}>`] as const),
    ...Object.entries(names.databases).map(([k, v]) => [v, `<db:${k}>`] as const),
  ]);
  const normalise = (line: string) =>
    line.replace(/[a-z_][a-z0-9_]*/g, (word) => slots.get(word) ?? word);
  const lines: string[] = [];
  for (const logical of LOGICAL) {
    const db = new SQL(url(physicalDatabaseName(names, logical)), { max: 1 });
    try {
      const rows = (await db.unsafe(`
        SELECT 'owner|' || c.oid::regclass || '|' || c.relkind::text || '|' || pg_get_userbyid(c.relowner) AS l
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        UNION ALL
        SELECT 'acl|' || c.oid::regclass || '|' || coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC')
               || '|' || a.privilege_type || '|' || a.is_grantable || '|' || pg_get_userbyid(a.grantor)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        UNION ALL
        SELECT 'colacl|' || att.attrelid::regclass || '.' || att.attname || '|'
               || coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC') || '|' || a.privilege_type
          FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
         WHERE att.attacl IS NOT NULL
        UNION ALL
        SELECT 'schema|' || n.nspname || '|' || pg_get_userbyid(n.nspowner) || '|' || coalesce(n.nspacl::text, '')
          FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
        UNION ALL
        SELECT 'routine|' || p.oid::regprocedure || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(p.proacl::text, '')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        UNION ALL
        SELECT 'policy|' || pol.polrelid::regclass || '|' || pol.polname || '|' || pol.polcmd::text || '|'
               || (SELECT string_agg(coalesce(pg_get_userbyid(nullif(u, 0)), 'PUBLIC'), ',' ORDER BY 1) FROM unnest(pol.polroles) u)
               || '|' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
               || '|' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
          FROM pg_policy pol
        UNION ALL
        SELECT 'extension|' || extname || '|' || (SELECT rolsuper FROM pg_roles WHERE oid = extowner) FROM pg_extension
        UNION ALL
        SELECT 'migration|' || hash FROM __drizzle_migrations
      `)) as { l: string }[];
      lines.push(...rows.map((r) => `${logical}|${normalise(r.l)}`));
    } finally {
      await db.end();
    }
  }
  const su = new SQL(url("postgres"), { max: 1 });
  try {
    const shared = (await su.unsafe(`
      SELECT 'database|' || d.datname || '|' || pg_get_userbyid(d.datdba) || '|'
             || coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC') || '|' || a.privilege_type AS l
        FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
       WHERE d.datname IN (${installDatabases(names)
         .map((n) => `'${n}'`)
         .join(", ")})
      UNION ALL
      SELECT 'dbsetting|' || d.datname || '|' || coalesce(pg_get_userbyid(nullif(s.setrole, 0)), '*') || '|' || array_to_string(s.setconfig, ',')
        FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
       WHERE d.datname IN (${installDatabases(names)
         .map((n) => `'${n}'`)
         .join(", ")})
      UNION ALL
      SELECT 'role|' || r.rolname || '|' || r.rolcanlogin || '|' || r.rolinherit || '|' || r.rolconnlimit
             || '|' || coalesce(array_to_string(r.rolconfig, ','), '') || '|' || r.rolsuper || r.rolcreatedb || r.rolcreaterole
        FROM pg_roles r WHERE r.rolname IN (${installRoles(names)
          .map((n) => `'${n}'`)
          .join(", ")})
      UNION ALL
      SELECT 'member|' || g.rolname || '|' || m.rolname || '|' || a.admin_option || a.inherit_option || a.set_option
        FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
       WHERE g.rolname IN (${installRoles(names)
         .map((n) => `'${n}'`)
         .join(", ")})
         AND m.rolname IN (${installRoles(names)
           .map((n) => `'${n}'`)
           .join(", ")})
    `)) as { l: string }[];
    lines.push(...shared.map((r) => normalise(r.l)));
  } finally {
    await su.end();
  }
  return lines.sort();
}

let su: SQL;

beforeAll(async () => {
  su = new SQL(url("postgres"), { max: 2 });
  for (const names of OURS) await dropInstall(su, names);
  await run(["sh", "src/bootstrap.sh"], {
    ...installNamesEnv(B),
    ADMIN_ROLE_PASSWORD: PASSWORDS.admin,
    PUBLIC_ROLE_PASSWORD: PASSWORDS.public,
    PUBLIC_STAGING_ROLE_PASSWORD: PASSWORDS.publicStaging,
    ADMIN_ROLE_CONNECTION_LIMIT: String(ADMIN_CONNECTION_LIMIT),
  });
  await migrate(B);
}, 600_000);

afterAll(async () => {
  try {
    for (const names of OURS) await dropInstall(su, names);
  } finally {
    await su.end();
  }
}, 120_000);

describe("a template copy (#1689)", () => {
  // Runs first: nothing may be connected to the template (install B) while
  // CREATE DATABASE copies it.
  it("two copies at once both succeed, with the fingerprint of fresh migrations", async () => {
    const copy = (target: InstallNames) =>
      installFromTemplate({
        connect: (database) => new SQL(url(database), { max: 2 }),
        maintenanceDatabase: "postgres",
        template: B,
        target,
        passwords: PASSWORDS,
      });
    const [r1, r2] = await Promise.all([copy(C1), copy(C2)]);
    expect(r1.databases).toEqual(installDatabases(C1));
    const [limit] =
      (await su`SELECT rolconnlimit AS n FROM pg_roles WHERE rolname = ${C1.roles.admin}`) as {
        n: number;
      }[];
    expect(limit?.n).toBe(ADMIN_CONNECTION_LIMIT);
    expect(r2.databases).toEqual(installDatabases(C2));
    const fresh = await fingerprint(B);
    expect(fresh.length).toBeGreaterThan(500);
    expect(await fingerprint(C1)).toEqual(fresh);
    expect(await fingerprint(C2)).toEqual(fresh);
  }, 300_000);

  it("draws every per-install secret anew and publishes the copy's own (Codex review)", async () => {
    const secretsOf = async (names: InstallNames) => {
      const admin = new SQL(url(names.databases.admin), { max: 1 });
      const live = new SQL(url(names.databases.public), { max: 1 });
      const staging = new SQL(url(names.databases.publicStaging), { max: 1 });
      try {
        const values: Record<string, string | null> = {};
        for (const s of INSTALL_SECRETS) {
          const [row] = (await admin.unsafe(`SELECT ${s.column}::text AS v FROM ${s.table}`)) as {
            v: string | null;
          }[];
          values[`${s.table}.${s.column}`] = row?.v ?? null;
        }
        const published = async (db: SQL) =>
          (
            (await db.unsafe("SELECT cookie_secret FROM published_gateway_settings")) as {
              cookie_secret: string;
            }[]
          )[0]?.cookie_secret ?? null;
        return { values, live: await published(live), staging: await published(staging) };
      } finally {
        await Promise.all([admin.end(), live.end(), staging.end()]);
      }
    };
    const [b, c1, c2] = await Promise.all([secretsOf(B), secretsOf(C1), secretsOf(C2)]);
    for (const key of Object.keys(b.values)) {
      expect({ key, set: b.values[key] !== null }).toEqual({ key, set: true });
      expect(new Set([b.values[key], c1.values[key], c2.values[key]]).size).toBe(3);
    }
    for (const c of [c1, c2]) {
      expect(c.live).toBe(c.values["site_settings.gateway_cookie_secret"] ?? "missing");
      expect(c.staging).toBe(c.values["site_settings.gateway_staging_cookie_secret"] ?? "missing");
    }
  });

  it("never takes over an install that exists, and leaves it intact", async () => {
    const before = await fingerprint(C1);
    await expect(
      installFromTemplate({
        connect: (database) => new SQL(url(database), { max: 2 }),
        maintenanceDatabase: "postgres",
        template: B,
        target: C1,
        passwords: PASSWORDS,
      }),
    ).rejects.toThrow("already exist on the server");
    expect(await fingerprint(C1)).toEqual(before);
  }, 120_000);

  it("a copy admits no other login before it is closed, not even for a moment", async () => {
    // A new database lets PUBLIC connect until that is revoked, and a REVOKE
    // ends no session already open: a login of another install that got in
    // between would stay in this install's database. Probe right after each
    // CREATE DATABASE, before the copy's next statement.
    const [, publicOfA] = loginsOfA();
    if (!publicOfA) throw new Error("PUBLIC_DATABASE_URL names no login");
    const probes: { db: string; opened: boolean }[] = [];
    const connect = (database: string): SQL => {
      const sql = new SQL(url(database), { max: 2 });
      if (database !== "postgres") return sql;
      return new Proxy(sql, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "unsafe") return typeof value === "function" ? value.bind(target) : value;
          return async (query: string) => {
            const result = await target.unsafe(query);
            const created = /^CREATE DATABASE "([a-z0-9_]+)"/.exec(query)?.[1];
            if (created) {
              probes.push({
                db: created,
                opened: await canConnect(publicOfA.user, publicOfA.password, created),
              });
            }
            return result;
          };
        },
      });
    };
    await installFromTemplate({
      connect,
      maintenanceDatabase: "postgres",
      template: B,
      target: C3,
      passwords: PASSWORDS,
    });
    expect(probes).toEqual(installDatabases(C3).map((db) => ({ db, opened: false })));
    expect(await canConnect(C3.roles.admin, PASSWORDS.admin, C3.databases.admin)).toBe(true);
  }, 120_000);

  it("the copy migrates and audits clean as its own install", async () => {
    await migrate(C1);
    expect(await canConnect(C1.roles.admin, PASSWORDS.admin, C1.databases.admin)).toBe(true);
  }, 300_000);
});

describe("two installs on one server (#1689)", () => {
  it("no login of one install opens any database of the other, in both directions", async () => {
    for (const [logins, other] of [
      [loginsOfA(), B],
      [loginsOf(B), A],
      [loginsOf(B), C1],
      [loginsOf(C1), B],
    ] as const) {
      for (const { user, password } of logins) {
        for (const db of installDatabases(other)) {
          expect({ user, db, connects: await canConnect(user, password, db) }).toEqual({
            user,
            db,
            connects: false,
          });
        }
      }
    }
  }, 120_000);

  it("no role of one install may SET ROLE to a role of the other", async () => {
    const adminOfA = new SQL(env.ADMIN_DATABASE_URL as string, { max: 1 });
    const adminOfB = new SQL(url(B.databases.admin, B.roles.admin, PASSWORDS.admin), { max: 1 });
    try {
      for (const [session, other] of [
        [adminOfA, B],
        [adminOfB, A],
      ] as const) {
        for (const role of installRoles(other)) {
          const exists = (await su`SELECT 1 FROM pg_roles WHERE rolname = ${role}`) as unknown[];
          if (exists.length === 0) continue;
          await expect(
            (async () => {
              await session.begin(async (tx) => {
                await tx.unsafe(`SET LOCAL ROLE "${role}"`);
              });
            })(),
          ).rejects.toThrow(/permission denied to set role/);
        }
      }
    } finally {
      await adminOfA.end();
      await adminOfB.end();
    }
  });

  it("the role audit of each install passes with the other on the server", async () => {
    for (const names of [A, B]) {
      for (const logical of LOGICAL) {
        const db = new SQL(url(physicalDatabaseName(names, logical)), { max: 1 });
        try {
          await assertNoForeignReferences(db, logical, names);
          if (logical === "cms_admin") await assertRoleIsolation(db, names);
          else await assertPublicDatabaseOwnsItsLogin(db, logical, names);
        } finally {
          await db.end();
        }
      }
    }
  });

  it("the role audit fails on a cross-install grant, CONNECT or policy", async () => {
    const aAdmin = new SQL(url(A.databases.admin), { max: 1 });
    const bAdmin = new SQL(url(B.databases.admin), { max: 1 });
    try {
      await aAdmin.unsafe(`GRANT SELECT ON pages TO "${B.roles.public}"`);
      await aAdmin.unsafe(`GRANT CONNECT ON DATABASE ${A.databases.admin} TO "${B.roles.admin}"`);
      await bAdmin.unsafe(
        `CREATE POLICY ci1689_foreign ON pages FOR SELECT TO "${A.roles.public}" USING (false)`,
      );
      await expect(assertNoForeignReferences(aAdmin, "cms_admin", A)).rejects.toThrow(
        `${B.roles.public}, a role of another install, holds a privilege on table pages`,
      );
      await expect(assertNoForeignReferences(aAdmin, "cms_admin", A)).rejects.toThrow(
        `${B.roles.admin}, a role of another install, holds a privilege on database ${A.databases.admin}`,
      );
      await expect(assertRoleIsolation(bAdmin, B)).rejects.toThrow(
        `${B.roles.admin} can connect to ${A.databases.admin}, a database of another install`,
      );
      await expect(assertNoForeignReferences(bAdmin, "cms_admin", B)).rejects.toThrow(
        `${A.roles.public}, a role of another install, is named by policy ci1689_foreign on table pages`,
      );
    } finally {
      await aAdmin.unsafe(`REVOKE SELECT ON pages FROM "${B.roles.public}"`);
      await aAdmin.unsafe(
        `REVOKE CONNECT ON DATABASE ${A.databases.admin} FROM "${B.roles.admin}"`,
      );
      await bAdmin.unsafe("DROP POLICY IF EXISTS ci1689_foreign ON pages");
      await aAdmin.end();
      await bAdmin.end();
    }
    const aAgain = new SQL(url(A.databases.admin), { max: 1 });
    try {
      await assertNoForeignReferences(aAgain, "cms_admin", A);
    } finally {
      await aAgain.end();
    }
  });

  it("the role audit fails on a membership in another install's role, even without INHERIT (Codex review)", async () => {
    // SET ROLE reaches the other role's privileges whatever INHERIT says:
    // A's admin could switch to B's admin and grant itself CONNECT on B.
    await su.unsafe(`GRANT "${B.roles.admin}" TO "${A.roles.admin}" WITH INHERIT FALSE, SET TRUE`);
    const aAdmin = new SQL(url(A.databases.admin), { max: 1 });
    try {
      await expect(assertRoleIsolation(aAdmin, A)).rejects.toThrow(
        `${A.roles.admin} can connect to ${B.databases.admin} through its membership in ${B.roles.admin}, a database of another install`,
      );
    } finally {
      await su.unsafe(`REVOKE "${B.roles.admin}" FROM "${A.roles.admin}"`);
      await aAdmin.end();
    }
    const aAgain = new SQL(url(A.databases.admin), { max: 1 });
    try {
      await assertRoleIsolation(aAgain, A);
    } finally {
      await aAgain.end();
    }
  });

  it("an adapter refuses another install's URL, and accepts its own", async () => {
    const wrong = new DatabaseAdapter({
      adminDatabaseUrl: url(B.databases.admin, B.roles.admin, PASSWORDS.admin),
      publicDatabaseUrl: url(B.databases.public, B.roles.admin, PASSWORDS.admin),
      names: A,
    });
    const right = new DatabaseAdapter({
      adminDatabaseUrl: url(B.databases.admin, B.roles.admin, PASSWORDS.admin),
      publicDatabaseUrl: url(B.databases.public, B.roles.admin, PASSWORDS.admin),
      names: B,
    });
    try {
      await expect(wrong.verifyRoles()).rejects.toThrow(
        `expected (admin_role, cms_admin) but connected as (${B.roles.admin}, ${B.databases.admin})`,
      );
      await right.verifyRoles();
    } finally {
      await wrong.close();
      await right.close();
    }
  });

  it("a plugin provisioned for install B grants to B's roles only", async () => {
    const pluginId = "16891689-1689-4689-8689-168916891689";
    const adapter = new DatabaseAdapter({
      adminDatabaseUrl: url(B.databases.admin, B.roles.admin, PASSWORDS.admin),
      publicDatabaseUrl: url(B.databases.public, B.roles.admin, PASSWORDS.admin),
      names: B,
    });
    const stagingAdapter = new DatabaseAdapter({
      adminDatabaseUrl: null,
      publicDatabaseUrl: url(B.databases.publicStaging, B.roles.admin, PASSWORDS.admin),
      publicDatabase: "cms_public_staging",
      names: B,
      expectedRoles: { admin: null, public: [B.roles.admin] },
    });
    try {
      await provisionPluginPublicSchemas(
        { adapter, stagingAdapter },
        {
          pluginId,
          slug: "ci1689-probe",
          schema: { notes: { body: "text" }, inbox: { body: "text" } },
          indexes: undefined,
          tableKinds: { notes: "published", inbox: "inbox" },
        },
      );
      await adapter.provisionPluginAdminSchema({
        pluginId,
        sql: adminSchemaFromSpec({
          pluginId,
          slug: "ci1689-probe",
          adminSchema: { settings: { label: "string" } },
          indexes: undefined,
          target: adminGrantTarget(adapter.installNames.roles),
        }).sql,
      });
      for (const logical of LOGICAL) {
        const db = new SQL(url(physicalDatabaseName(B, logical)), { max: 1 });
        try {
          const grantees = (await db.unsafe(`
            SELECT DISTINCT pg_get_userbyid(a.grantee) AS role
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              CROSS JOIN LATERAL aclexplode(c.relacl) a
             WHERE n.nspname = 'plugin_ci1689_probe'
          `)) as { role: string }[];
          expect(grantees.length).toBeGreaterThan(0);
          for (const { role } of grantees) expect(installRoles(B)).toContain(role);
          await assertNoForeignReferences(db, logical, B);
        } finally {
          await db.end();
        }
      }
    } finally {
      await adapter.close();
      await stagingAdapter.close();
    }
  });
});

describe("bootstrap.sh on a shared server (#1689)", () => {
  it("admits no other login to a new database before it is closed, not even for a moment", async () => {
    // The same gap as a template copy's: bootstrap.sh creates each database
    // in one psql call and closes it in a later one. A psql in front of the
    // real one tries to get in as A's live gateway login right after each
    // CREATE DATABASE and logs what happened.
    const [, publicOfA] = loginsOfA();
    const realPsql = Bun.which("psql");
    if (!publicOfA || !realPsql) throw new Error("needs PUBLIC_DATABASE_URL and psql on PATH");
    const dir = mkdtempSync(join(tmpdir(), "ci1689-psql-"));
    const log = join(dir, "probes.log");
    writeFileSync(log, "");
    writeFileSync(
      join(dir, "psql"),
      [
        "#!/bin/sh",
        '"$CI1689_REAL_PSQL" "$@"',
        "code=$?",
        "db=$(printf '%s\\n' \"$@\" | sed -n 's/^CREATE DATABASE \\([a-z0-9_]*\\).*/\\1/p')",
        'if [ -n "$db" ]; then',
        '  if out=$(PGPASSWORD="$CI1689_PROBE_PASSWORD" "$CI1689_REAL_PSQL" -U "$CI1689_PROBE_USER" -d "$db" -Atc "SELECT 1" 2>&1); then',
        '    echo "$db opened" >> "$CI1689_PROBE_LOG"',
        "  else",
        '    echo "$db refused: $(printf "%s" "$out" | tr "\\n" " ")" >> "$CI1689_PROBE_LOG"',
        "  fi",
        "fi",
        'exit "$code"',
        "",
      ].join("\n"),
    );
    chmodSync(join(dir, "psql"), 0o755);
    try {
      await run(["sh", "src/bootstrap.sh"], {
        ...installNamesEnv(D),
        PATH: `${dir}:${env.PATH ?? ""}`,
        ADMIN_ROLE_PASSWORD: PASSWORDS.admin,
        PUBLIC_ROLE_PASSWORD: PASSWORDS.public,
        PUBLIC_STAGING_ROLE_PASSWORD: PASSWORDS.publicStaging,
        CI1689_REAL_PSQL: realPsql,
        CI1689_PROBE_USER: publicOfA.user,
        CI1689_PROBE_PASSWORD: publicOfA.password,
        CI1689_PROBE_LOG: log,
      });
      const probes = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      expect(probes.map((line) => line.split(" ")[0])).toEqual(installDatabases(D));
      for (const line of probes) {
        expect(line).toMatch(
          / refused: .*(permission denied for database|is not currently accepting connections)/,
        );
      }
      expect(await canConnect(D.roles.admin, PASSWORDS.admin, D.databases.admin)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await dropInstall(su, D);
    }
  }, 120_000);
});

describe("bootstrap.sh refuses names that belong to someone else (#1689)", () => {
  // A role of the map that exists would be altered (connection limit,
  // settings, memberships) and handed the map's databases, and DROP OWNED
  // BY the former gateway login also revokes that role's CONNECT on every
  // other database of the server: with install A's live login there, A's
  // gateway could not reconnect.
  const E = prefixedInstallNames("ci1689e");

  it("stops before its first statement when a name of the map is install A's", async () => {
    const aclBefore = (await su`
      SELECT datacl::text AS acl FROM pg_database WHERE datname = ${A.databases.public}
    `) as { acl: string }[];
    const cases: [InstallNames, string][] = [
      [
        { ...E, roles: { ...E.roles, formerGateway: A.roles.public } },
        `role ${A.roles.public} exists and may connect to ${A.databases.public}`,
      ],
      [
        { ...E, roles: { ...E.roles, admin: A.roles.admin } },
        `role ${A.roles.admin} exists and may connect to ${A.databases.admin}`,
      ],
      [
        { ...E, databases: { ...E.databases, public: A.databases.public } },
        `database ${A.databases.public} exists and belongs to ${A.roles.admin}, not ${E.roles.admin}`,
      ],
      [
        { ...E, roles: { ...E.roles, platformUpdater: env.POSTGRES_USER as string } },
        `role ${env.POSTGRES_USER} exists and is a superuser`,
      ],
    ];
    try {
      for (const [names, why] of cases) {
        let failure = "";
        try {
          await run(["sh", "src/bootstrap.sh"], {
            ...installNamesEnv(names),
            ADMIN_ROLE_PASSWORD: PASSWORDS.admin,
            PUBLIC_ROLE_PASSWORD: PASSWORDS.public,
            PUBLIC_STAGING_ROLE_PASSWORD: PASSWORDS.publicStaging,
          });
        } catch (e) {
          failure = String(e);
        }
        expect(failure).toContain("belongs to someone else on this server");
        expect(failure).toContain(why);
      }
      const prefix = "ci1689e\\_%";
      expect(await su`SELECT rolname FROM pg_roles WHERE rolname LIKE ${prefix}`).toEqual([]);
      expect(await su`SELECT datname FROM pg_database WHERE datname LIKE ${prefix}`).toEqual([]);
      expect(
        await su`SELECT datacl::text AS acl FROM pg_database WHERE datname = ${A.databases.public}`,
      ).toEqual(aclBefore);
    } finally {
      await dropInstall(su, E);
    }
  }, 120_000);

  it("re-runs on its own install as before", async () => {
    await run(["sh", "src/bootstrap.sh"], {
      ...installNamesEnv(B),
      ADMIN_ROLE_PASSWORD: PASSWORDS.admin,
      PUBLIC_ROLE_PASSWORD: PASSWORDS.public,
      PUBLIC_STAGING_ROLE_PASSWORD: PASSWORDS.publicStaging,
      ADMIN_ROLE_CONNECTION_LIMIT: String(ADMIN_CONNECTION_LIMIT),
    });
    expect(await canConnect(B.roles.admin, PASSWORDS.admin, B.databases.admin)).toBe(true);
  }, 120_000);
});

describe("names Postgres reserves (Codex review)", () => {
  // A keyword would need quoting in the CREATE ROLE, GRANT and renamed
  // migration statements, which splice names unquoted.
  const KW = prefixedInstallNames("ci1689kw");

  it("the name map refuses every keyword this server needs quoted", async () => {
    const rows = (await su`
      SELECT word FROM pg_get_keywords() WHERE catcode <> 'U' ORDER BY word
    `) as { word: string }[];
    expect(rows.length).toBeGreaterThan(100);
    const accepted = rows
      .map((r) => r.word)
      .filter((word) => {
        try {
          parseInstallNames({ ...KW, roles: { ...KW.roles, admin: word } }, "map");
          return true;
        } catch {
          return false;
        }
      });
    expect(accepted).toEqual([]);
  });

  it("bootstrap.sh refuses a keyword, or a role named public, before it creates anything", async () => {
    const bad: [InstallNames, string][] = [
      [{ ...KW, roles: { ...KW.roles, admin: "select" } }, "roles,admin"],
      // Postgres reserves "public" for its PUBLIC pseudo-role (Codex review).
      [{ ...KW, roles: { ...KW.roles, public: "public" } }, "roles,public"],
    ];
    for (const [names, slot] of bad) {
      let failure = "";
      try {
        await run(["sh", "src/bootstrap.sh"], {
          ...installNamesEnv(names),
          ADMIN_ROLE_PASSWORD: PASSWORDS.admin,
          PUBLIC_ROLE_PASSWORD: PASSWORDS.public,
          PUBLIC_STAGING_ROLE_PASSWORD: PASSWORDS.publicStaging,
        });
      } catch (e) {
        failure = String(e);
      }
      expect(failure).toContain(`no valid name at ${slot}`);
    }
    // Every name of the map starts with its prefix (prefixedInstallNames).
    const prefix = "ci1689kw\\_%";
    const roles = (await su`
      SELECT rolname FROM pg_roles WHERE rolname LIKE ${prefix}
    `) as { rolname: string }[];
    const databases = (await su`
      SELECT datname FROM pg_database WHERE datname LIKE ${prefix}
    `) as { datname: string }[];
    expect(roles).toEqual([]);
    expect(databases).toEqual([]);
  });
});
