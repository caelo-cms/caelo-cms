-- SPDX-License-Identifier: MPL-2.0
--
-- 0274 — Lighthouse Performance metrics per audited page.
--
-- The gate drops the Performance metrics (FCP, LCP, TBT, CLS, Speed
-- Index) from the findings because the category score already measures
-- them. An AI or an external MCP agent making a page faster still needs to
-- know WHICH metric is bad and which element causes it — without them it
-- guessed, or ran Lighthouse itself against a URL that is not the staged
-- build.
--
--   quality_audit_pages.metrics   per page Lighthouse audited: every metric
--                                 as the median over the Performance runs
--                                 (numericValue + unit, displayValue,
--                                 score, each run's value; null with a
--                                 reason when a run did not measure it),
--                                 the LCP element and breakdown, and the
--                                 largest layout shifts with their causes.
--                                 NULL for check-only rows, errored pages
--                                 and rows before this migration.
--
-- Data, not findings: nothing in the gate reads this column.
--
-- Expand-only (#696): one new nullable column. The previous image neither
-- reads nor writes it.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE quality_audit_pages
  ADD COLUMN metrics jsonb NULL;

-- The fix playbook learns where to look when Performance is the problem.
-- Targeted replace() guarded by `body LIKE` on the exact old sentence (as
-- 0273): idempotent, and an Owner-edited body that no longer carries it
-- stays.
UPDATE skills
   SET body = replace(
     body,
     'use the theme''s self-hosted fonts.',
     'use the theme''s self-hosted fonts. For a Performance score below its baseline, read the page''s metrics in `get_quality_audit` first (FCP, LCP, TBT, CLS, Speed Index — the median of the staged build''s runs, with the LCP element, its breakdown and the elements that shifted) and fix the worst one in the module that renders that element. Never run Lighthouse yourself: the audit already ran against the real staged build.'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%use the theme''s self-hosted fonts.%'
   AND body NOT LIKE '%read the page''s metrics in `get_quality_audit` first%';

COMMIT;
