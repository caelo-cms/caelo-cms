-- SPDX-License-Identifier: MPL-2.0
--
-- 0128 — issue #247 (WS1, design ground truth): the crawl's Playwright
-- render pass now samples computed styles (getComputedStyle on body,
-- h1-h3, p, a, nav, footer, the most prominent button) into a compact
-- deterministic design-token JSON. Two storage points:
--
--   import_pages.sampled_design_tokens — per-page summary (palette,
--     font stacks/sizes/weights, radii, shadows, per-role properties),
--     written by the orchestrator's ground-truth capture pass.
--   import_runs.site_design_tokens — the site-level aggregate the
--     theme proposal consumes; compose_from_run prefers it over the
--     extractor's inline-CSS-derived proposed_theme_tokens (computed
--     styles are ground truth; extractor tokens stay as fallback for
--     fetch-only crawls without Playwright).
--
-- No full stylesheet is ever stored here or fed to an AI prompt —
-- these summaries are a few KB by construction (epic #252 non-goal:
-- no CSS replay).

BEGIN;

ALTER TABLE import_pages
  ADD COLUMN IF NOT EXISTS sampled_design_tokens jsonb;

ALTER TABLE import_runs
  ADD COLUMN IF NOT EXISTS site_design_tokens jsonb;

COMMIT;
