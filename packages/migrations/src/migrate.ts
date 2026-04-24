// SPDX-License-Identifier: MPL-2.0

/**
 * Runs the drizzle-generated migrations for cms_admin or cms_public, then applies
 * the RLS policies from rls.ts (drizzle-kit does not model RLS in its generator).
 *
 *   bun run src/migrate.ts admin
 *   bun run src/migrate.ts public
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { buildRlsSql, CMS_ADMIN_RLS, CMS_PUBLIC_GRANTS_SQL, CMS_PUBLIC_RLS } from "./rls.js";

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

async function applyRls(sql: SQL, t: Target): Promise<void> {
  const specs = t === "admin" ? CMS_ADMIN_RLS : CMS_PUBLIC_RLS;
  const policySql = buildRlsSql(specs);
  await sql.unsafe(policySql);
  if (t === "public") {
    await sql.unsafe(CMS_PUBLIC_GRANTS_SQL);
  }
  console.log(`applied RLS policies to ${specs.length} table(s) in cms_${t}`);
}

const sql = new SQL(url);
try {
  await runMigrations(sql, migrationsDir);
  await applyRls(sql, target);
  console.log(`cms_${target}: migrations + RLS up to date`);
} finally {
  await sql.end();
}
