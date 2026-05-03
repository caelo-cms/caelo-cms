-- SPDX-License-Identifier: MPL-2.0
--
-- P11.6 — per-plugin AI cost cap + ai_calls plugin attribution.
--
-- Without this a Tier-1 plugin's chat-runner-tool spawn can drain the
-- daily AI budget with no per-plugin visibility or cap. After this:
--   - ai_calls.plugin_id (nullable; set by chat-runner when the call
--     was made on behalf of a plugin tool dispatch),
--   - plugins.ai_cost_cap_microcents (per-plugin daily cap; NULL = no cap),
--   - /security/plugins/[slug] gains an "AI spend (last 24h)" cell
--     + the cap-hit error surfaces in the plugin's ctx.ai.complete()
--     handler when sum(cost_estimate_microcents) for the trailing 24h
--     ≥ cap. Plugin operations using ctx.ai keep working until they
--     hit the cap, then fail loudly.

ALTER TABLE ai_calls
  ADD COLUMN IF NOT EXISTS plugin_id uuid NULL REFERENCES plugins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_calls_plugin_idx
  ON ai_calls (plugin_id, created_at DESC)
  WHERE plugin_id IS NOT NULL;

ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS ai_cost_cap_microcents bigint NULL;

-- Locale-aware declaration: every Tier-2 manifest, and Tier-1 plugins
-- that publish per-page tables, declare whether the plugin treats data
-- as locale-scoped. The validator (P11) enforces:
--   locale_aware = true  → every page_id-scoped table MUST include locale.
--   locale_aware = false → no page_id-scoped table may exist (manifest
--                          rejection at activation if a column with
--                          page_id is declared without locale_aware).
-- NULL during migration window; backfill in the same migration:
--   - All currently-active Tier-1 plugins that touch per-page data are
--     locale-aware (translation, comments) → true.
--   - Plugins with no page_id columns (auth, ratings has page_id+locale)
--     → conservatively true since migrating later is cheaper than
--     a forced-true assumption that breaks the validator.
ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS locale_aware boolean NULL;

UPDATE plugins SET locale_aware = true WHERE locale_aware IS NULL;
ALTER TABLE plugins ALTER COLUMN locale_aware SET NOT NULL;
ALTER TABLE plugins ALTER COLUMN locale_aware SET DEFAULT true;
