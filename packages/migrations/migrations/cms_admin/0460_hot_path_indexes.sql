-- SPDX-License-Identifier: MPL-2.0
--
-- 0460 — issue #1291: the hot-path queries that read a growing table had
-- no index they could use, so each one scanned the whole table.
--
-- Found by running the test suite with `enable_seqscan = off` and
-- auto_explain: a filtered Seq Scan left in that mode means no usable
-- index exists for the predicate.
--
-- Plain CREATE INDEX in the runner's transaction: both tables hold one
-- row per accepted finding / per redirect (thousands at most), so the
-- build lock lasts milliseconds. The indexes on the tables that grow
-- with every request (ai_calls, audit_events, chat_messages,
-- page_edit_log) are built CONCURRENTLY in 0463.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

-- Quality record-result (`ops/quality/record-result.ts`) reads the live
-- finding + score acceptances of every audited page, once per page per
-- Stage. The per-kind partial unique indexes cannot answer
-- `kind IN ('finding','score')`, and the page_id FK (ON DELETE CASCADE)
-- had no index of its own. One plain (page_id, kind) index serves both;
-- revoked rows per page are few, so `revoked_at IS NULL` stays a filter.
CREATE INDEX IF NOT EXISTS quality_acceptances_page_kind_idx
  ON quality_acceptances (page_id, kind);

-- Page moves and slug changes (`ops/content/path-moves.ts`) collapse
-- redirect chains with `UPDATE redirects … WHERE to_path = old_path`.
CREATE INDEX IF NOT EXISTS redirects_to_path_idx
  ON redirects (to_path);

-- No pg_trgm index for the `ILIKE '%…%'` search of `redirects.list` /
-- `find_redirects`: under the table's RLS policy the planner must
-- evaluate the policy before any non-leakproof predicate, and ILIKE is
-- not leakproof, so it can never become an index condition for
-- admin_role (measured: a GIN trgm index stays unused, Seq Scan).

COMMIT;
