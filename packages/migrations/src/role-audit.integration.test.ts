// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #633 against a real Postgres made to look like Cloud SQL: a
 * `cloudsqlsuperuser` group with `public_role` in it, CREATEROLE + CREATEDB
 * on `public_role`, and CONNECT / TEMPORARY on both databases left to PUBLIC
 * (Cloud SQL never runs bootstrap.sh). The superuser connection plays Cloud
 * SQL's own administrator, i.e. the Admin API.
 *
 * Proves, in order: the role audit refuses that state; the migration role
 * cannot revoke the membership in SQL (why `cms-provision` goes through the
 * Admin API); after the revoke, migration 0278 closes cms_admin to
 * public_role without locking out any role that uses a database, and the
 * audit passes — both idempotent; where the migration role may alter
 * public_role, 0278 also drops its CREATEROLE / CREATEDB.
 *
 * Restores the bootstrap.sh state afterwards so the other suites are
 * unaffected.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { assertRoleIsolation } from "./role-audit.js";

const env = process.env;
const required = [
  "POSTGRES_USER",
  "POSTGRES_PORT",
  "ADMIN_DATABASE_URL",
  "PUBLIC_DATABASE_URL",
  "GATEWAY_DATABASE_URL",
] as const;
const missing = required.filter((name) => !env[name]);
if (missing.length > 0) throw new Error(`${missing.join(", ")} required (see .env.example)`);

const superuserUrl = (db: string) => {
  const u = new URL(`postgres://localhost/${db}`);
  u.hostname = env.PGHOST ?? "localhost";
  u.port = env.POSTGRES_PORT as string;
  u.username = env.POSTGRES_USER as string;
  if (env.POSTGRES_PASSWORD) u.password = env.POSTGRES_PASSWORD;
  return u.toString();
};
const onDatabase = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

const migration0278 = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "cms_admin",
  "0278_public_role_isolation.sql",
);

/** Whether `url` can open a session (CONNECT privilege). */
async function canConnect(url: string): Promise<boolean> {
  const sql = new SQL(url, { max: 1 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch (e) {
    if (/permission denied for database/i.test(String(e))) return false;
    throw e;
  } finally {
    await sql.end();
  }
}

let su: SQL;
let admin: SQL;

/** Run migration 0278's SQL as admin_role, as migrate.ts does. */
async function runMigration0278(): Promise<void> {
  const body = await readFile(migration0278, "utf8");
  await admin.begin(async (tx) => {
    await tx.unsafe(body);
  });
}

async function attributes(): Promise<{ rolcreaterole: boolean; rolcreatedb: boolean }> {
  const [row] = (await su`
    SELECT rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'public_role'
  `) as { rolcreaterole: boolean; rolcreatedb: boolean }[];
  if (!row) throw new Error("public_role does not exist");
  return row;
}

async function restoreBootstrapState(): Promise<void> {
  const members = (await su`
    SELECT 1 FROM pg_auth_members a
      JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
     WHERE g.rolname = 'public_role' AND m.rolname = 'admin_role'
  `) as unknown[];
  if (members.length > 0) await su.unsafe("REVOKE public_role FROM admin_role");
  await su.unsafe("ALTER ROLE admin_role NOCREATEROLE NOCREATEDB");
  await su.unsafe("ALTER ROLE public_role NOCREATEROLE NOCREATEDB");
  const group = (await su`SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser'`) as unknown[];
  if (group.length > 0) {
    await su.unsafe("REVOKE cloudsqlsuperuser FROM public_role");
    await su.unsafe("DROP ROLE cloudsqlsuperuser");
  }
  await su.unsafe("REVOKE ALL ON DATABASE cms_admin FROM PUBLIC");
  await su.unsafe("REVOKE ALL ON DATABASE cms_public FROM PUBLIC");
  await su.unsafe("GRANT CONNECT ON DATABASE cms_admin TO admin_role, gateway_role");
  await su.unsafe("GRANT CONNECT ON DATABASE cms_public TO admin_role, public_role");
}

beforeAll(async () => {
  su = new SQL(superuserUrl("cms_admin"), { max: 1 });
  admin = new SQL(env.ADMIN_DATABASE_URL as string, { max: 2 });
  await restoreBootstrapState();
  // Cloud SQL's state for an Admin API user.
  await su.unsafe("CREATE ROLE cloudsqlsuperuser NOLOGIN CREATEROLE CREATEDB");
  await su.unsafe("GRANT cloudsqlsuperuser TO public_role");
  await su.unsafe("ALTER ROLE public_role CREATEROLE CREATEDB");
  await su.unsafe("GRANT CONNECT, TEMPORARY ON DATABASE cms_admin TO PUBLIC");
  await su.unsafe("GRANT CONNECT, TEMPORARY ON DATABASE cms_public TO PUBLIC");
});

afterAll(async () => {
  try {
    await restoreBootstrapState();
  } finally {
    await admin.end();
    await su.end();
  }
});

describe("public_role isolation on a Cloud SQL-shaped database (#633)", () => {
  const publicOnAdmin = onDatabase(env.PUBLIC_DATABASE_URL as string, "cms_admin");

  it("the audit refuses public_role in cloudsqlsuperuser with CONNECT on cms_admin", async () => {
    expect(await canConnect(publicOnAdmin)).toBe(true);
    await expect(assertRoleIsolation(admin)).rejects.toThrow(
      "public_role is a member of cloudsqlsuperuser (it must be of none)",
    );
    await expect(assertRoleIsolation(admin)).rejects.toThrow(
      "public_role can connect to cms_admin",
    );
  });

  it("the migration role cannot revoke the membership in SQL — the Admin API must", async () => {
    // A Bun SQL query only runs once awaited, so wrap it in a real Promise.
    const revoke = (async () => {
      await admin.unsafe("REVOKE cloudsqlsuperuser FROM public_role");
    })();
    await expect(revoke).rejects.toThrow(/permission denied to revoke role "cloudsqlsuperuser"/);
    const [row] = (await su`
      SELECT count(*)::int AS n FROM pg_auth_members a
        JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
       WHERE g.rolname = 'cloudsqlsuperuser' AND m.rolname = 'public_role'
    `) as { n: number }[];
    expect(row?.n).toBe(1);
  });

  it("after the revoke, 0278 + the audit pass and close cms_admin to public_role — twice", async () => {
    // What `gcloud sql users assign-roles public_role --revoke-existing-roles` does.
    await su.unsafe("REVOKE cloudsqlsuperuser FROM public_role");
    for (let run = 0; run < 2; run++) {
      await runMigration0278();
      const audit = await assertRoleIsolation(admin);
      expect(audit.violations).toEqual([]);
      // The local admin_role has no CREATEROLE, so it could not drop them.
      expect(audit.warnings).toEqual([
        "public_role has CREATEROLE + CREATEDB (migration 0278 could not drop it with the migration role's rights)",
      ]);
    }
    expect(await canConnect(publicOnAdmin)).toBe(false);
    // Nobody who uses a database lost it.
    expect(await canConnect(env.PUBLIC_DATABASE_URL as string)).toBe(true);
    expect(await canConnect(env.GATEWAY_DATABASE_URL as string)).toBe(true);
    expect(await canConnect(env.ADMIN_DATABASE_URL as string)).toBe(true);
    expect(await canConnect(onDatabase(env.ADMIN_DATABASE_URL as string, "cms_public"))).toBe(true);
    const [pub] = (await su`
      SELECT has_database_privilege('public', 'cms_admin', 'CONNECT') AS admin_connect,
             has_database_privilege('public', 'cms_public', 'TEMPORARY') AS public_temp
    `) as { admin_connect: boolean; public_temp: boolean }[];
    expect(pub).toEqual({ admin_connect: false, public_temp: false });
  });

  it("drops CREATEROLE + CREATEDB where the migration role may alter public_role", async () => {
    // Cloud SQL's admin_role: CREATEROLE + CREATEDB, and ADMIN OPTION on the role.
    await su.unsafe("ALTER ROLE admin_role CREATEROLE CREATEDB");
    await su.unsafe("GRANT public_role TO admin_role WITH ADMIN OPTION");
    try {
      expect(await attributes()).toEqual({ rolcreaterole: true, rolcreatedb: true });
      await runMigration0278();
      expect(await attributes()).toEqual({ rolcreaterole: false, rolcreatedb: false });
      await runMigration0278();
      const audit = await assertRoleIsolation(admin);
      expect(audit).toEqual({ violations: [], warnings: [] });
    } finally {
      await su.unsafe("REVOKE public_role FROM admin_role");
      await su.unsafe("ALTER ROLE admin_role NOCREATEROLE NOCREATEDB");
    }
  });

  it("refuses again if anything puts public_role back into the group", async () => {
    await su.unsafe("GRANT cloudsqlsuperuser TO public_role");
    try {
      await expect(assertRoleIsolation(admin)).rejects.toThrow(
        "public_role is a member of cloudsqlsuperuser",
      );
    } finally {
      await su.unsafe("REVOKE cloudsqlsuperuser FROM public_role");
    }
  });
});
