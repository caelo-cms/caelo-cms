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

export {};
