-- SPDX-License-Identifier: MPL-2.0
--
-- 0302 — issue #874: the quality audit scores Performance by the page's
-- best Lighthouse run, not the median of the runs.
--
-- fix-quality-findings told the AI the metrics are "the median of the
-- staged build's runs" (0274). They are now the best run's values, the
-- same run the Performance score comes from. Targeted replace() guarded by
-- `body LIKE` on the exact old phrase (as 0274): idempotent, and an
-- Owner-edited body that no longer carries it stays.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     'the median of the staged build''s runs,',
     'the best of the staged build''s runs, the one the Performance score comes from,'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%the median of the staged build''s runs,%';

COMMIT;
