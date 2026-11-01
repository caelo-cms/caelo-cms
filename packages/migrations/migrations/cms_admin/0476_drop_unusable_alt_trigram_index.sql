-- SPDX-License-Identifier: MPL-2.0
--
-- 0476 — drop `media_assets_alt_trgm_idx`, which no admin read can use
-- (issue #1297).
--
-- Migration 0024 created a pg_trgm GIN index on `media_assets.alt` for the
-- `alt ILIKE '%q%'` search of media.list / find_media. Under row-level
-- security it can never drive that search: the planner evaluates a
-- table's policy quals before any user predicate that is not LEAKPROOF
-- (`restriction_is_securely_promotable`, restrictinfo.c), and an index
-- condition is evaluated before every filter. `~~*` (texticlike) is not
-- leakproof, and media_assets' policy is FORCEd for admin_role, so the
-- ILIKE always stays a row filter. (The search is also an OR with
-- `original_name ILIKE …`, which has no index at all.) The index only cost
-- every media write a GIN update.
--
-- No index replaces it: no substring operator is leakproof, and marking
-- one leakproof takes a superuser, which Cloud SQL does not grant. The
-- search stays a scan of the live media rows; `migrations/src/rls-planner.
-- integration.test.ts` refuses a trigram index on any RLS table, so a
-- later migration cannot add one that looks like it helps.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

DROP INDEX IF EXISTS media_assets_alt_trgm_idx;

COMMIT;
