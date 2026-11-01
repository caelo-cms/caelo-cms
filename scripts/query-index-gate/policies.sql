-- SPDX-License-Identifier: MPL-2.0
--
-- Issue #1293 — the RLS policy quals the query index gate drops from plan
-- filters (analyze.ts --policies). Run with `psql -At -F '<TAB>'` against
-- each database after the integration run, so plugin schemas created
-- during the run are included. One line per policy, whitespace collapsed.
SELECT schemaname || '.' || tablename,
       regexp_replace(qual, '\s+', ' ', 'g')
FROM pg_policies
WHERE qual IS NOT NULL
ORDER BY 1;
