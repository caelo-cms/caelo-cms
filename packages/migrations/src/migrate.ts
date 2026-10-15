// SPDX-License-Identifier: MPL-2.0

/**
 * Runs the committed SQL migrations for cms_admin or cms_public, applies RLS
 * to the bookkeeping table, and runs a drift check that asserts every app
 * table has at least one RLS policy.
 *
 *   bun run src/migrate.ts admin
 *   bun run src/migrate.ts public
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseUrlFromEnv } from "@caelo-cms/shared";
// Read SQL via globalThis.Bun (Bun's runtime sets it natively). The
// type-only import is erased at compile time so the bundler never sees
// a value-import of "bun" — avoids the SvelteKit/Vite chain inlining
// a stub package when admin transitively imports this module.
import type { SQL as SQLType } from "bun";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { type ProjectionDatabases, publishPublicProjection } from "./public-projection.js";
import { assertRoleIsolation } from "./role-audit.js";
import { readShippedVisitorProjections } from "./shipped-declarations.js";

type SQL = SQLType;
const SQL = (globalThis as { Bun?: { SQL: new (url: string) => SQLType } }).Bun
  ?.SQL as unknown as new (
  url: string,
) => SQLType;

type Target = "admin" | "public";

const target = process.argv[2];
if (target !== "admin" && target !== "public") {
  console.error("usage: bun run src/migrate.ts <admin|public>");
  process.exit(1);
}

const url = databaseUrlFromEnv([
  target === "admin" ? "ADMIN_DATABASE_URL" : "PUBLIC_ADMIN_DATABASE_URL",
]);
if (!url) {
  console.error(
    `missing env var: ${target === "admin" ? "ADMIN_DATABASE_URL" : "PUBLIC_ADMIN_DATABASE_URL"}`,
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(
  here,
  "..",
  "migrations",
  target === "admin" ? "cms_admin" : "cms_public",
);

async function runMigrations(sql: SQL, dir: string): Promise<void> {
  const { Glob } = await import("bun");
  const glob = new Glob("*.sql");
  const files = (await Array.fromAsync(glob.scan({ cwd: dir, absolute: true }))).sort();

  await sql`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint not null
    )
  `;
  // Bookkeeping table: never touched via the Query API, always via this runner
  // as admin_role. Enable RLS (without FORCE) so the "every table has RLS"
  // invariant is mechanically true; an open policy keeps admin_role writes
  // working. public_role has no GRANT here either way.
  await sql.unsafe(`ALTER TABLE __drizzle_migrations ENABLE ROW LEVEL SECURITY`);
  await sql.unsafe(
    `DROP POLICY IF EXISTS __drizzle_migrations_bookkeeping ON __drizzle_migrations`,
  );
  await sql.unsafe(
    `CREATE POLICY __drizzle_migrations_bookkeeping ON __drizzle_migrations USING (true) WITH CHECK (true)`,
  );

  for (const file of files) {
    const hash = file.split("/").at(-1) ?? file;
    const [row] = await sql`SELECT 1 FROM __drizzle_migrations WHERE hash = ${hash}`;
    if (row) continue;

    const body = await readFile(file, "utf8");
    const statements = body
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Run each migration inside a transaction with SET LOCAL caelo.actor_kind = 'system'
    // so seed INSERTs can write to RLS-`FORCE`d tables (actors, audit_events, etc.).
    // CREATE DATABASE isn't in migrations — those are handled by bootstrap.sh — so
    // it's safe to wrap everything in BEGIN/COMMIT here.
    await sql.begin(async (tx: SQL) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const stmt of statements) {
        await tx.unsafe(stmt);
      }
      await tx`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${Date.now()})`;
    });
    console.log(`applied: ${hash}`);
  }
}

/**
 * Drift check. Fails if any app table (non-meta) exists without at least one
 * RLS policy. Ensures a future contributor who adds a table can't silently
 * ship it without protection — the test suite won't save us, but this will.
 */
const META_TABLES = new Set(["__drizzle_migrations"]);

async function assertNoRlsPolicyDrift(sql: SQL): Promise<void> {
  const offenders = (await sql`
    SELECT c.relname::text AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
      )
    ORDER BY c.relname
  `) as unknown as { table_name: string }[];
  const appOffenders = offenders.filter((r) => !META_TABLES.has(r.table_name));
  if (appOffenders.length > 0) {
    const names = appOffenders.map((r) => r.table_name).join(", ");
    throw new Error(
      `RLS drift: tables without any pg_policies row: ${names}. Add CREATE POLICY to the matching 9999_rls_policies.sql migration.`,
    );
  }
}

/**
 * Issue #635 — after cms_public is migrated, publish the projection the
 * API gateway reads (it has no cms_admin login), so a gateway rolled right
 * after this job finds everything it serves from. Needs both URLs: every
 * runner (the Cloud Run migration job, the self-hosted admin container,
 * CI, `bun run db:migrate`) carries them.
 */
async function publishProjection(publicUrl: string): Promise<void> {
  const adminUrl = databaseUrlFromEnv(["ADMIN_DATABASE_URL"]);
  if (!adminUrl) {
    throw new Error(
      "migrate public: ADMIN_DATABASE_URL is required to publish the gateway's projection (issue #635); the migration job carries both database URLs",
    );
  }
  const adminClient = new SQL(adminUrl);
  const publicClient = new SQL(publicUrl);
  const admin = drizzle(adminClient);
  const pub = drizzle(publicClient);
  const asSystem = dsql`SELECT set_config('caelo.actor_kind', 'system', true)`;
  const dbs: ProjectionDatabases = {
    readAdmin: (fn) =>
      admin.transaction(async (tx) => {
        await tx.execute(asSystem);
        return fn(tx);
      }),
    writePublic: (fn) =>
      pub.transaction(async (tx) => {
        await tx.execute(asSystem);
        await fn(tx);
      }),
  };
  try {
    const declarations = readShippedVisitorProjections(resolve(here, "..", "..", "plugins"));
    const report = await publishPublicProjection(dbs, declarations, { comments: true });
    console.log(`cms_public: gateway projection published (${report.sections.join(", ")})`);
    for (const slug of report.pendingPlugins) {
      console.warn(
        `cms_public: ${slug}'s declared tables are not provisioned yet; the admin publishes them when it boots`,
      );
    }
  } finally {
    await adminClient.end();
    await publicClient.end();
  }
}

const sql = new SQL(url);
try {
  await runMigrations(sql, migrationsDir);
  await assertNoRlsPolicyDrift(sql);
  console.log(`cms_${target as Target}: migrations applied, RLS drift check passed`);
  if (target === "admin") {
    // Issue #633 — the role catalogue is cluster-wide, so one run (on
    // cms_admin, where the CONNECT check matters) covers both databases.
    // A violation exits non-zero: the migration job fails and no upgrade
    // rolls a service onto an install whose public login is over-privileged.
    const audit = await assertRoleIsolation(sql);
    for (const w of audit.warnings) console.warn(`role isolation warning: ${w}`);
    console.log("cms_admin: database role isolation check passed");
  } else {
    await publishProjection(url);
  }
} finally {
  await sql.end();
}
