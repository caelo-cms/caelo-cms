// SPDX-License-Identifier: MPL-2.0

/**
 * Applies the committed SQL migrations of one database directory, in file
 * order, each in its own transaction (or, marked `caelo:no-transaction`,
 * statement by statement outside one), recording each in
 * `__drizzle_migrations`. `migrate.ts` is the entrypoint; this module holds
 * the runner so it can be exercised against a real Postgres in tests.
 */

import { readFile } from "node:fs/promises";
import { DEFAULT_INSTALL_NAMES, type InstallNames } from "@caelo-cms/shared";
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
 * Which database a migration run is for. The cms_public files serve both
 * public databases: the staging run (#1329) takes the same files with the
 * visitor login retargeted to the staging gateway's.
 */
export type MigrationTarget = "admin" | "public" | "public-staging";

/**
 * Issue #1689 — the role and database names the committed migration files
 * are written with: today's names ({@link DEFAULT_INSTALL_NAMES}). The
 * runner renames each whole-word occurrence to the install's own name
 * ({@link renameForInstall}), so one set of files serves every install on a
 * shared Postgres server and no file is edited.
 */
const WRITTEN_ROLES = DEFAULT_INSTALL_NAMES.roles;
const WRITTEN_DATABASES = DEFAULT_INSTALL_NAMES.databases;

/**
 * What each name in the migration files becomes for `names` and `target`:
 * every role and database the install's own name, and in the staging run
 * the live visitor login (`public_role`) the staging one — the #1329
 * retarget, so the staging database grants its own gateway what the live
 * one grants the live gateway. The role audit proves the outcome
 * (role-audit.ts `assertPublicDatabaseOwnsItsLogin`, `assertNoForeignGrantees`).
 */
export function installNameTokens(
  names: InstallNames,
  target: MigrationTarget,
): ReadonlyMap<string, string> {
  const visitor = target === "public-staging" ? names.roles.publicStaging : names.roles.public;
  return new Map<string, string>([
    [WRITTEN_ROLES.admin, names.roles.admin],
    [WRITTEN_ROLES.public, visitor],
    [WRITTEN_ROLES.publicStaging, names.roles.publicStaging],
    [WRITTEN_ROLES.operatorAccessReader, names.roles.operatorAccessReader],
    [WRITTEN_ROLES.platformUpdater, names.roles.platformUpdater],
    [WRITTEN_ROLES.formerGateway, names.roles.formerGateway],
    [WRITTEN_DATABASES.admin, names.databases.admin],
    [WRITTEN_DATABASES.public, names.databases.public],
    [WRITTEN_DATABASES.publicStaging, names.databases.publicStaging],
  ]);
}

/**
 * A migration with every whole-word written name replaced by the
 * install's (`tokens` from {@link installNameTokens}): its GRANTs, its
 * `TO <role>` policies, its role checks and its `ON DATABASE` statements
 * then target this install's roles and databases. One pass, whole words
 * only: a longer identifier that merely contains a name
 * (`caelo_grant_platform_updater`, `my_public_role`) stays as it is, and a
 * replacement is never replaced again.
 *
 * @example renameForInstall("GRANT SELECT ON t TO public_role;", installNameTokens(DEFAULT_INSTALL_NAMES, "public-staging"))
 *   // → "GRANT SELECT ON t TO public_staging_role;"
 */
export function renameForInstall(body: string, tokens: ReadonlyMap<string, string>): string {
  if ([...tokens].every(([from, to]) => from === to)) return body;
  for (const to of tokens.values()) {
    // The names come from a validated map; this keeps a hand-built map
    // from splicing anything but an identifier into a migration.
    if (!/^[a-z_][a-z0-9_]*$/.test(to)) {
      throw new Error(`renameForInstall: "${to}" is not a role or database name`);
    }
  }
  const alternatives = [...tokens.keys()].sort((a, b) => b.length - a.length).join("|");
  const word = new RegExp(`(?<![A-Za-z0-9_$])(?:${alternatives})(?![A-Za-z0-9_$])`, "g");
  return body.replace(word, (name) => tokens.get(name) ?? name);
}

/** Options of {@link runMigrations}. */
export interface RunMigrationsOptions {
  /** The install's names; {@link DEFAULT_INSTALL_NAMES} unless given. */
  readonly names?: InstallNames;
  /** Which database the run is for; `admin` unless given (only the renaming depends on it). */
  readonly target?: MigrationTarget;
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
  const tokens = installNameTokens(
    options.names ?? DEFAULT_INSTALL_NAMES,
    options.target ?? "admin",
  );
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
  // as the install's admin role. Enable RLS (without FORCE) so the "every
  // table has RLS" invariant is mechanically true; an open policy keeps the
  // admin role's writes working. The visitor login has no GRANT here either way.
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
    pending.push({ name, body: renameForInstall(await readFile(file, "utf8"), tokens) });
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
