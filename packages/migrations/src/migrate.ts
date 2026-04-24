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
import { SQL } from "bun";

type Target = "admin" | "public";

const target = process.argv[2];
if (target !== "admin" && target !== "public") {
  console.error("usage: bun run src/migrate.ts <admin|public>");
  process.exit(1);
}

const url =
  target === "admin" ? process.env["ADMIN_DATABASE_URL"] : process.env["PUBLIC_ADMIN_DATABASE_URL"];
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
    for (const stmt of statements) {
      await sql.unsafe(stmt);
    }
    await sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${Date.now()})`;
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

const sql = new SQL(url);
try {
  await runMigrations(sql, migrationsDir);
  await assertNoRlsPolicyDrift(sql);
  console.log(`cms_${target as Target}: migrations applied, RLS drift check passed`);
} finally {
  await sql.end();
}
