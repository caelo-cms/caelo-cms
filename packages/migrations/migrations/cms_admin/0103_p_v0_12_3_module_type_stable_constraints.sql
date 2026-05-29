-- SPDX-License-Identifier: MPL-2.0
--
-- 0103 — Stable module `type` + allowedModuleSlugs → allowedModuleTypes
--        (issue #106).
--
-- Problem: a parent module's nested-ref whitelist was stored as
-- `allowedModuleSlugs` and matched against `modules.slug`. But every
-- AI-minted module gets a uniqueness suffix (`button-mpqxq3ch`), so an
-- allowlist authored as `["button"]` could NEVER match — the live-edit
-- AI hit the validator, then punted the failure to the operator.
--
-- Fix: introduce a STABLE `modules.type` (the reusable class — `button`,
-- `pricing-card` — shared by every instance) and match the whitelist
-- against it. Rename the stored field key to `allowedModuleTypes` to
-- reflect what it now matches.
--
-- Backfill is NON-LOSSY: `type` is backfilled to the existing `slug`, so
-- a legacy allowlist holding an EXACT slug keeps matching (its target's
-- type == its slug). AI-minted modules — whose new `type` is the slug
-- base without the suffix — start matching too.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + UPDATE … WHERE type IS NULL +
-- ALTER … SET NOT NULL (no-op if already set) + the JSON rewrite guarded
-- by `WHERE EXISTS (… ? 'allowedModuleSlugs')` so a re-run is a no-op.
-- All in one transaction.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- ─── modules.type column (add nullable → backfill → NOT NULL) ─────────

ALTER TABLE modules
  ADD COLUMN IF NOT EXISTS type text;

-- Backfill to slug: non-lossy for legacy exact-slug allowlists.
UPDATE modules
  SET type = slug
  WHERE type IS NULL;

ALTER TABLE modules
  ALTER COLUMN type SET NOT NULL;

-- Intentionally NO unique constraint: many `button-xxxx` modules share
-- `type = 'button'`. Identity stays on the unique `slug`.

-- ─── Rename stored field key inside modules.fields JSON ──────────────
--
-- Only `module` / `module-list` field kinds carry the key. Rebuild the
-- fields array element-by-element, renaming `allowedModuleSlugs` →
-- `allowedModuleTypes` on the elements that have it and leaving every
-- other element (primitives, lists) untouched. The EXISTS guard makes
-- the statement touch only rows that still carry the old key, so a
-- second run is a no-op and the empty-`fields` rows are skipped (which
-- also avoids jsonb_agg-over-zero-rows returning NULL).

UPDATE modules
  SET fields = (
    SELECT jsonb_agg(
      CASE
        WHEN elem ? 'allowedModuleSlugs'
          THEN (elem - 'allowedModuleSlugs')
               || jsonb_build_object('allowedModuleTypes', elem -> 'allowedModuleSlugs')
        ELSE elem
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(fields) WITH ORDINALITY AS t(elem, ord)
  )
  WHERE jsonb_typeof(fields) = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(fields) AS e
      WHERE e ? 'allowedModuleSlugs'
    );

COMMIT;
