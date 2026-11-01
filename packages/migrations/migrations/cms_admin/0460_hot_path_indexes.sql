-- SPDX-License-Identifier: MPL-2.0
--
-- 0460 — issue #1291: the hot-path queries that read a growing table had
-- no index they could use, so each one scanned the whole table.
--
-- Found by running the test suite with `enable_seqscan = off` and
-- auto_explain: a filtered Seq Scan left in that mode means no usable
-- index exists for the predicate.
--
-- Plain CREATE INDEX (no CONCURRENTLY): the runner applies every file in
-- one transaction (runner.ts), and CONCURRENTLY cannot run inside one.
-- The tables below are small enough on today's installs that the build
-- lock lasts milliseconds; the scans they replace grow with the site.

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

-- MCP cost cap (`ops/security/mcp_tool_call.ts` spentMicrocents) runs on
-- every capped MCP tool call: `chat_session_id = $1 OR (actor_id = $2 AND
-- created_at >= …)`. With this index the planner ORs it with
-- ai_calls_actor_idx (a BitmapOr) instead of scanning every AI call ever
-- made. created_at also serves the quality gate's per-chat chain sum
-- (`ops/quality/gate.ts`). Partial: rows without a chat are never looked
-- up by it; `chat_session_id = $1` (and the FK check) implies NOT NULL,
-- so the planner still uses it.
CREATE INDEX IF NOT EXISTS ai_calls_chat_session_idx
  ON ai_calls (chat_session_id, created_at)
  WHERE chat_session_id IS NOT NULL;

-- Page moves and slug changes (`ops/content/path-moves.ts`) collapse
-- redirect chains with `UPDATE redirects … WHERE to_path = old_path`.
CREATE INDEX IF NOT EXISTS redirects_to_path_idx
  ON redirects (to_path);

-- No pg_trgm index for the `ILIKE '%…%'` search of `redirects.list` /
-- `find_redirects`: under the table's RLS policy the planner must
-- evaluate the policy before any non-leakproof predicate, and ILIKE is
-- not leakproof, so it can never become an index condition for
-- admin_role (measured: a GIN trgm index stays unused, Seq Scan).

-- audit_events is the largest table and had indexes only on id,
-- entity_id and request_id. `audit_events.aggregate_by_op_prefix`
-- (`ops/security/ai_calls_by_op.ts`) reads a time window of it.
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
  ON audit_events (created_at);

COMMIT;
