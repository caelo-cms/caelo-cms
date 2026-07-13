-- SPDX-License-Identifier: MPL-2.0
--
-- 0137 — issue #248 (WS2, rebuild quality checks): two enforcement
-- surfaces the REBUILD CONTRACT (0130) needs so "improve while
-- rebuilding" can never quietly become "drop content".
--
--   1. Content-inventory / no-information-loss check
--      (imports.check_page_inventory). It compares the source page's
--      crawled content against the rebuilt page's modules and reports
--      every heading/paragraph/list-item/image/link/CTA that went
--      missing. When something is missing the op records a LOUD
--      `content_missing` per-page note (never a silent drop, CLAUDE.md
--      2), so the closing run report surfaces the gap for the operator.
--
--   2. Repeated-subtree boilerplate detection across a run's pages
--      (imports.detect_boilerplate). A block that recurs on >=N pages
--      is boilerplate, not per-page content; the op stores a compact
--      summary on the run so the run report can surface the detected
--      boilerplate and its suggested placement level (layout /
--      template / shared content_instance).
--
-- Only a small nullable jsonb column is added here — the detection and
-- matching algorithms are pure code in @caelo-cms/site-importer
-- (unit-tested), not SQL. No CSS or full page HTML is ever stored in
-- this column; the summary is a few KB of candidate metadata.

BEGIN;

ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS boilerplate_summary jsonb NULL;

COMMENT ON COLUMN import_runs.boilerplate_summary IS
  'issue #248 — latest imports.detect_boilerplate result: {pagesAnalyzed, candidates:[{signature,kind,tag,pageCount,suggestedPlacement,...}]}. Surfaced in the run report so the rebuild binds boilerplate once at the right level instead of copying it per page.';

COMMIT;
