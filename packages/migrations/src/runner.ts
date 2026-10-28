// SPDX-License-Identifier: MPL-2.0

/**
 * Applies the committed SQL migrations of one database directory, in file
 * order, each in its own transaction, recording each in
 * `__drizzle_migrations`. `migrate.ts` is the entrypoint; this module holds
 * the runner so it can be exercised against a real Postgres in tests.
 */

import { readFile } from "node:fs/promises";
import type { SQL } from "bun";
import { MigrationRunOrderError, type PendingMigration, runOrderViolations } from "./run-order.js";

/** The file name a migration is recorded under. */
function migrationName(file: string): string {
  return file.split("/").at(-1) ?? file;
}

/**
 * Apply every migration in `dir` not yet recorded. Refuses the whole run
 * before applying anything when the release ordering is violated
 * ({@link runOrderViolations}).
 */
export async function runMigrations(sql: SQL, dir: string): Promise<string[]> {
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

  const recorded = (await sql`SELECT hash FROM __drizzle_migrations`) as { hash: string }[];
  const appliedBefore = new Set(recorded.map((r) => r.hash));
  const pending: PendingMigration[] = [];
  for (const file of files) {
    const name = migrationName(file);
    if (appliedBefore.has(name)) continue;
    pending.push({ name, body: await readFile(file, "utf8") });
  }
  const violations = runOrderViolations({
    pending,
    appliedBefore,
    available: files.map(migrationName),
  });
  if (violations.length > 0) throw new MigrationRunOrderError(violations);

  const applied: string[] = [];
  for (const { name, body } of pending) {
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
      // Migration 0392's limits are for the running admin, not for a
      // backfill or an index build, nor for a migration that waits for the
      // locks of a long request to clear.
      await tx.unsafe("SET LOCAL statement_timeout = 0");
      await tx.unsafe("SET LOCAL lock_timeout = 0");
      await tx.unsafe("SET LOCAL idle_in_transaction_session_timeout = 0");
      for (const stmt of statements) {
        await tx.unsafe(stmt);
      }
      await tx`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${name}, ${Date.now()})`;
    });
    console.log(`applied: ${name}`);
    applied.push(name);
  }
  return applied;
}
