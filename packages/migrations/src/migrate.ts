// SPDX-License-Identifier: MPL-2.0

/**
 * Runs the committed SQL migrations for cms_admin or cms_public, applies RLS
 * to the bookkeeping table, and runs a drift check that asserts every app
 * table has at least one RLS policy.
 *
 *   bun run src/migrate.ts admin
 *   bun run src/migrate.ts public
 */

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
import { assertPublicDatabaseIsolated, assertRoleIsolation } from "./role-audit.js";
import { runMigrations } from "./runner.js";
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
    // Issue #635 — nothing in cms_public may bridge to another database.
    await assertPublicDatabaseIsolated(sql);
    console.log("cms_public: no bridge to other databases");
    await publishProjection(url);
  }
} finally {
  await sql.end();
}
