-- SPDX-License-Identifier: MPL-2.0
--
-- Issue #1293 — the leading key column of every index (analyze.ts
-- --indexes). On a tiny test table a whole-index walk and an index lookup
-- cost the same, so the planner may walk an index for its order although
-- another index serves the filter; the analyzer drops such a walk when an
-- index leads with one of the filter's columns. Run like policies.sql.
SELECT n.nspname || '.' || c.relname, a.attname
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
WHERE i.indkey[0] <> 0
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
ORDER BY 1, 2;
