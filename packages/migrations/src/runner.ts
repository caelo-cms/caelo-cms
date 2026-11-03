// SPDX-License-Identifier: MPL-2.0

/**
 * Applies the committed SQL migrations of one database directory, in file
 * order, each in its own transaction (or, marked `caelo:no-transaction`,
 * statement by statement outside one), recording each in
 * `__drizzle_migrations`. `migrate.ts` is the entrypoint; this module holds
 * the runner so it can be exercised against a real Postgres in tests.
 */

import { readFile } from "node:fs/promises";
import type { SQL } from "bun";
import { MigrationRunOrderError, type PendingMigration, runOrderViolations } from "./run-order.js";

const NO_TRANSACTION = /^--\s*caelo:no-transaction\s*$/;

/**
 * Whether a migration's leading comment header carries
 * `-- caelo:no-transaction` (#1291). Such a file runs statement by
 * statement outside a transaction, for what Postgres refuses inside one —
 * `CREATE INDEX CONCURRENTLY` on a table that grows with every request,
 * where a plain build's SHARE lock would stall the running admin's writes.
 * Only the header counts, like `caelo:requires-earlier-run`.
 */
export function runsOutsideTransaction(body: string): boolean {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("--")) return false;
    if (NO_TRANSACTION.test(line)) return true;
  }
  return false;
}

/**
 * Apply a `caelo:no-transaction` migration: each `--> statement-breakpoint`
 * part is its own statement on one reserved connection (a multi-statement
 * string would run as an implicit transaction again), then the file is
 * recorded. A failure part-way leaves the file unrecorded, so the next run
 * repeats it from the top — the file must be written to be re-run (drop an
 * index before building it CONCURRENTLY: an interrupted build leaves an
 * INVALID index that `IF NOT EXISTS` would keep).
 */
async function applyOutsideTransaction(
  sql: SQL,
  name: string,
  statements: readonly string[],
): Promise<void> {
  const conn = await sql.reserve();
  try {
    // Session-level twins of the SET LOCALs the transactional path uses.
    await conn.unsafe("SET caelo.actor_kind = 'system'");
    await conn.unsafe("SET statement_timeout = 0");
    await conn.unsafe("SET lock_timeout = 0");
    await conn.unsafe("SET idle_in_transaction_session_timeout = 0");
    for (const stmt of statements) {
      await conn.unsafe(stmt);
    }
    await conn`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${name}, ${Date.now()})`;
  } finally {
    // A connection that broke mid-file cannot be reset; the error that broke
    // it is the one that propagates, not this cleanup's.
    await conn.unsafe("RESET ALL").catch(() => undefined);
    conn.release();
  }
}

/**
 * Issue #1329 — the role the cms_public migrations name for the gateway's
 * visitor-facing login. The staging database `cms_public_staging` is the
 * same schema with its own login (`public_staging_role`), so its run takes
 * the same files with that one name swapped ({@link retargetVisitorRole}).
 */
export const LIVE_VISITOR_ROLE = "public_role";

/** The staging gateway's login in `cms_public_staging` (#1329). */
export const STAGING_VISITOR_ROLE = "public_staging_role";

const LIVE_VISITOR_ROLE_TOKEN = /(?<![A-Za-z0-9_$])public_role(?![A-Za-z0-9_$])/g;

/**
 * A cms_public migration with every whole-word `public_role` replaced by
 * `role`: its GRANTs, its `TO public_role` policies and its role checks
 * then target the staging gateway's login. One set of files, so the two
 * public databases cannot drift apart; whole words only, so a longer
 * identifier that merely contains the name stays as it is. The role audit
 * proves the outcome: in cms_public_staging nothing is granted to
 * public_role, in cms_public nothing to public_staging_role
 * (role-audit.ts `assertPublicDatabaseOwnsItsRole`).
 *
 * @example retargetVisitorRole("GRANT SELECT ON t TO public_role;", "public_staging_role")
 *   // → "GRANT SELECT ON t TO public_staging_role;"
 */
export function retargetVisitorRole(body: string, role: string): string {
  if (role === LIVE_VISITOR_ROLE) return body;
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`retargetVisitorRole: "${role}" is not a role name`);
  }
  return body.replace(LIVE_VISITOR_ROLE_TOKEN, role);
}

/** Options of {@link runMigrations}. */
export interface RunMigrationsOptions {
  /**
   * The visitor role this database's migrations grant to; `public_role`
   * unless given. The cms_public_staging run passes
   * {@link STAGING_VISITOR_ROLE}.
   */
  readonly visitorRole?: string;
}

/** The file name a migration is recorded under. */
function migrationName(file: string): string {
  return file.split("/").at(-1) ?? file;
}

/**
 * Apply every migration in `dir` not yet recorded. Refuses the whole run
 * before applying anything when the release ordering is violated
 * ({@link runOrderViolations}).
 */
export async function runMigrations(
  sql: SQL,
  dir: string,
  options: RunMigrationsOptions = {},
): Promise<string[]> {
  const visitorRole = options.visitorRole ?? LIVE_VISITOR_ROLE;
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
    pending.push({ name, body: retargetVisitorRole(await readFile(file, "utf8"), visitorRole) });
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

    if (runsOutsideTransaction(body)) {
      await applyOutsideTransaction(sql, name, statements);
      console.log(`applied: ${name}`);
      applied.push(name);
      continue;
    }
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
