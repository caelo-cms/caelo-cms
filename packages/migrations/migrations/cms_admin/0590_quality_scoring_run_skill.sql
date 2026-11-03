-- SPDX-License-Identifier: MPL-2.0
--
-- 0590 — issue #1370: the quality audit scores Performance by the best of
-- the runs that agree, or by the median of five when they disagree (the
-- page then gets confirmation runs).
--
-- fix-quality-findings told the AI the metrics are "the best of the staged
-- build's runs" (0302). Since #1370 they are the scoring run's values: the
-- best run, or the median run, as the metrics line of get_quality_audit
-- says. Targeted replace() guarded by `body LIKE` on the exact old phrase
-- (as 0274 and 0302): idempotent, and an Owner-edited body that no longer
-- carries it stays.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     'the best of the staged build''s runs, the one the Performance score comes from,',
     'the run the Performance score comes from: the best of the staged build''s runs when they agree, the median of five when they disagree, as the metrics line says,'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%the best of the staged build''s runs, the one the Performance score comes from,%';

COMMIT;
