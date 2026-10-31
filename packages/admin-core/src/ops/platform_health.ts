// SPDX-License-Identifier: MPL-2.0

/**
 * Migration bookkeeping reads for the admin's deep health check (epic #696).
 *
 * After an upgrade rolls the admin onto a new image, `cms-provision upgrade`
 * (and later the in-cloud upgrader job) asks `/_caelo/health?deep=1` whether
 * every migration that image ships is recorded as applied in both
 * databases. These ops return the recorded migration files; the route
 * compares them with the files the image carries.
 *
 * `__drizzle_migrations` is written only by the migration runner
 * (packages/migrations/src/migrate.ts) and holds file names, nothing else.
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const output = z.object({
  /** Applied migration file names, sorted. */
  applied: z.array(z.string()),
});

async function appliedMigrations(tx: TransactionRunner): Promise<string[]> {
  const rows = (await tx.execute(sql`SELECT hash FROM __drizzle_migrations`)) as unknown as Array<{
    hash: string;
  }>;
  // Sorted here, not by ORDER BY: Postgres sorts by the database's
  // collation, and a locale collation (en_US) puts "0198_plugin_…" before
  // "0198_p_mcp_…" where the C collation does not — the v0.10.45 release
  // gate failed on exactly that. Callers compare against file names sorted
  // by code-unit order, so the order must not depend on the database.
  return rows.map((r) => r.hash).sort();
}

export const appliedAdminMigrationsOp = defineOperation({
  name: "platform_health.applied_admin_migrations",
  readScope: "request",
  // Why system-only: deploy plumbing behind the admin's health route — the
  // route runs it as the system actor; no editor or AI decision reads it.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output,
  handler: async (_ctx, _input, tx) => ok({ applied: await appliedMigrations(tx) }),
});

export const appliedPublicMigrationsOp = defineOperation({
  name: "platform_health.applied_public_migrations",
  readScope: "request",
  // Why system-only: same as platform_health.applied_admin_migrations, for
  // cms_public.
  actorScope: ["system"],
  database: "cms_public",
  input: z.object({}).strict(),
  output,
  handler: async (_ctx, _input, tx) => ok({ applied: await appliedMigrations(tx) }),
});
