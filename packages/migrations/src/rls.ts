// SPDX-License-Identifier: MPL-2.0

/**
 * RLS policy model reference for Caelo.
 *
 * As of Phase 1.2, RLS policies live in committed SQL migration files
 * (9999_rls_policies.sql per database) — schema and policy co-evolve, drift
 * is caught by the drift check in migrate.ts. This module no longer generates
 * SQL at runtime; it documents the policy shapes so future phases (P11 plugin
 * tables, P2 user/role tables, etc.) can follow a known pattern.
 *
 *   Per-actor (cms_admin):
 *     USING      (<actor_col> = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
 *                 OR current_setting('caelo.actor_kind', true) = 'system')
 *     WITH CHECK (same — the `system` bypass must apply to writes too, or seeds
 *                 and P2 actor creation fail.)
 *
 *   Per-plugin (cms_public):
 *     USING      (<plugin_col> = NULLIF(current_setting('caelo.plugin_id', true), ''))
 *     WITH CHECK (same)
 *
 * `NULLIF(..., '')` is load-bearing: a missing session setting returns empty
 * string in Postgres (not NULL), and NULLIF normalises it to NULL for
 * consistent fail-closed semantics — `NULL = anything` is NULL, which RLS
 * treats as no match.
 *
 * Every table in `public` schema must have at least one pg_policies row, or
 * `migrate.ts`'s drift check fails. Meta tables (`__drizzle_migrations`) get
 * an open policy so the migration runner can operate normally.
 */

export interface RlsDriftRow {
  readonly schema_name: string;
  readonly table_name: string;
  readonly rls_enabled: boolean;
  readonly rls_forced: boolean;
  readonly has_policy: boolean;
}

const META_TABLES = new Set(["__drizzle_migrations"]);

export const RLS_DRIFT_SQL = `
  SELECT n.nspname::text AS schema_name,
         c.relname::text AS table_name,
         c.relrowsecurity AS rls_enabled,
         c.relforcerowsecurity AS rls_forced,
         EXISTS (
           SELECT 1 FROM pg_policies p
           WHERE p.schemaname = n.nspname AND p.tablename = c.relname
         ) AS has_policy
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE (n.nspname = 'public' OR n.nspname LIKE 'plugin_%')
     AND c.relkind = 'r'
     AND (
       NOT c.relrowsecurity
       OR NOT c.relforcerowsecurity
       OR NOT EXISTS (
         SELECT 1 FROM pg_policies p
         WHERE p.schemaname = n.nspname AND p.tablename = c.relname
       )
     )
   ORDER BY n.nspname, c.relname
`;

export function evaluateRlsDrift(rows: readonly RlsDriftRow[]): string[] {
  const problems: string[] = [];
  for (const r of rows) {
    if (r.schema_name === "public" && META_TABLES.has(r.table_name)) continue;
    const fq = r.schema_name === "public" ? r.table_name : `${r.schema_name}.${r.table_name}`;
    const missing: string[] = [];
    if (!r.rls_enabled) missing.push("ENABLE ROW LEVEL SECURITY");
    if (!r.rls_forced) missing.push("FORCE ROW LEVEL SECURITY");
    if (!r.has_policy) missing.push("CREATE POLICY");
    if (missing.length > 0) {
      problems.push(`${fq} (missing ${missing.join(", ")})`);
    }
  }
  return problems;
}

export async function assertNoRlsPolicyDrift(sql: {
  unsafe: (query: string) => Promise<unknown>;
}): Promise<void> {
  const rows = (await sql.unsafe(RLS_DRIFT_SQL)) as RlsDriftRow[];
  const problems = evaluateRlsDrift(rows);
  if (problems.length > 0) {
    throw new Error(
      `RLS drift: tables with incomplete RLS enforcement: ${problems.join("; ")}. Enable + force RLS and add CREATE POLICY to the migration.`,
    );
  }
}
