// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1329 — the live and the staging gateway's logins reach only their
 * own database, enforced by Postgres. Proven by connecting as each login
 * and trying the other environment's database (and cms_admin), on the
 * database bootstrap.sh and the migrations leave; then against a
 * Cloud SQL-shaped staging database (CONNECT left to PUBLIC, a gateway
 * login granted the other's database): the role audit refuses it and
 * migration 0530 closes it, twice in a row.
 *
 * Restores the bootstrap.sh state afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SQL } from "bun";
import { assertPublicDatabaseOwnsItsLogin, assertRoleIsolation } from "./role-audit.js";

const env = process.env;
const required = [
  "POSTGRES_USER",
  "POSTGRES_PORT",
  "ADMIN_DATABASE_URL",
  "PUBLIC_DATABASE_URL",
  "PUBLIC_STAGING_DATABASE_URL",
  "PUBLIC_STAGING_ADMIN_DATABASE_URL",
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

const LIVE_LOGIN = env.PUBLIC_DATABASE_URL as string;
const STAGING_LOGIN = env.PUBLIC_STAGING_DATABASE_URL as string;

/** "ok", or "denied" when Postgres refuses the session (CONNECT privilege). */
async function connectAs(url: string): Promise<"ok" | "denied"> {
  const sql = new SQL(url, { max: 1 });
  try {
    await sql`SELECT 1`;
    return "ok";
  } catch (e) {
    if (/permission denied for database/i.test(String(e))) return "denied";
    throw e;
  } finally {
    await sql.end();
  }
}

let su: SQL;
let admin: SQL;

async function restoreBootstrapState(): Promise<void> {
  await su.unsafe("REVOKE ALL ON DATABASE cms_public_staging FROM PUBLIC");
  await su.unsafe("REVOKE ALL ON DATABASE cms_public_staging FROM public_role");
  await su.unsafe("REVOKE ALL ON DATABASE cms_public FROM public_staging_role");
  await su.unsafe(
    "GRANT CONNECT ON DATABASE cms_public_staging TO admin_role, public_staging_role",
  );
}

beforeAll(async () => {
  su = new SQL(superuserUrl("cms_admin"), { max: 1 });
  admin = new SQL(env.ADMIN_DATABASE_URL as string, { max: 1 });
  await restoreBootstrapState();
});

afterAll(async () => {
  try {
    await restoreBootstrapState();
  } finally {
    await admin.end();
    await su.end();
  }
});

describe("each gateway login reaches its own database only (#1329)", () => {
  it("the live login opens cms_public and nothing else", async () => {
    expect(await connectAs(LIVE_LOGIN)).toBe("ok");
    expect(await connectAs(onDatabase(LIVE_LOGIN, "cms_public_staging"))).toBe("denied");
    expect(await connectAs(onDatabase(LIVE_LOGIN, "cms_admin"))).toBe("denied");
  });

  it("the staging login opens cms_public_staging and nothing else", async () => {
    expect(await connectAs(STAGING_LOGIN)).toBe("ok");
    expect(await connectAs(onDatabase(STAGING_LOGIN, "cms_public"))).toBe("denied");
    expect(await connectAs(onDatabase(STAGING_LOGIN, "cms_admin"))).toBe("denied");
  });

  it("neither public database grants the other environment's login anything", async () => {
    for (const [url, db] of [
      [env.PUBLIC_ADMIN_DATABASE_URL as string, "cms_public"],
      [env.PUBLIC_STAGING_ADMIN_DATABASE_URL as string, "cms_public_staging"],
    ] as const) {
      const sql = new SQL(url, { max: 1 });
      try {
        await assertPublicDatabaseOwnsItsLogin(sql, db);
      } finally {
        await sql.end();
      }
    }
  });

  it("the staging login holds the same visitor privileges in its database as the live one in its", async () => {
    const privileges = async (url: string, role: string) => {
      const sql = new SQL(url, { max: 1 });
      try {
        return (await sql.unsafe(`
          SELECT c.relname::text AS t, a.privilege_type::text AS p
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN LATERAL aclexplode(c.relacl) a
           WHERE n.nspname = 'public' AND a.grantee = '${role}'::regrole
           ORDER BY 1, 2`)) as { t: string; p: string }[];
      } finally {
        await sql.end();
      }
    };
    const live = await privileges(env.PUBLIC_ADMIN_DATABASE_URL as string, "public_role");
    const staging = await privileges(
      env.PUBLIC_STAGING_ADMIN_DATABASE_URL as string,
      "public_staging_role",
    );
    expect(live.length).toBeGreaterThan(0);
    expect(staging).toEqual(live);
  });
});

describe("a Cloud SQL-shaped staging database (#1329)", () => {
  const migration0530 = resolve(
    import.meta.dir,
    "..",
    "migrations",
    "cms_admin",
    "0530_public_staging_database.sql",
  );

  it("the audit refuses it; migration 0530 closes it, idempotently", async () => {
    // What the Admin API leaves, plus a misgrant across the environments.
    await su.unsafe("GRANT CONNECT, TEMPORARY ON DATABASE cms_public_staging TO PUBLIC");
    await su.unsafe("GRANT CONNECT ON DATABASE cms_public_staging TO public_role");
    await su.unsafe("GRANT CONNECT ON DATABASE cms_public TO public_staging_role");
    expect(await connectAs(onDatabase(LIVE_LOGIN, "cms_public_staging"))).toBe("ok");
    const refused = assertRoleIsolation(admin);
    await expect(refused).rejects.toThrow("PUBLIC may connect to cms_public_staging");
    await expect(refused).rejects.toThrow("public_role can connect to cms_public_staging");
    await expect(refused).rejects.toThrow("public_staging_role can connect to cms_public");

    const body = await readFile(migration0530, "utf8");
    for (let i = 0; i < 2; i++) {
      await admin.begin(async (tx) => {
        await tx.unsafe(body);
      });
      await assertRoleIsolation(admin);
    }
    expect(await connectAs(onDatabase(LIVE_LOGIN, "cms_public_staging"))).toBe("denied");
    expect(await connectAs(onDatabase(STAGING_LOGIN, "cms_public"))).toBe("denied");
    expect(await connectAs(STAGING_LOGIN)).toBe("ok");
  });
});
