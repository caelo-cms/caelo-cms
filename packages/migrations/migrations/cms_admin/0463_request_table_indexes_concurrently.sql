-- SPDX-License-Identifier: MPL-2.0
-- caelo:no-transaction
--
-- 0463 — issue #1291: indexes on the tables that grow with every request,
-- built without blocking their writes.
--
-- audit_events (one row per operation), ai_calls (one per AI call),
-- chat_messages and page_edit_log grow with use, not with the site. A
-- plain CREATE INDEX holds a SHARE lock for the whole build, so on an
-- install with a long history it would stall every audited write of the
-- running admin while the upgrade migrates. CONCURRENTLY builds without
-- that lock; it cannot run in a transaction, so this file runs outside
-- one (`caelo:no-transaction`, runner.ts), one statement per breakpoint.
--
-- Each index is dropped first: a CONCURRENTLY build that was interrupted
-- leaves an INVALID index behind that `IF NOT EXISTS` would keep. This
-- file is recorded only after its last statement, so a re-run after a
-- crash rebuilds whatever it had built.

-- MCP cost cap (`ops/security/mcp_tool_call.ts` spentMicrocents) runs on
-- every capped MCP tool call: `chat_session_id = $1 OR (actor_id = $2 AND
-- created_at >= …)`. With this index the planner ORs it with
-- ai_calls_actor_idx (a BitmapOr) instead of scanning every AI call ever
-- made. created_at also serves the quality gate's per-chat chain sum
-- (`ops/quality/gate.ts`). Partial: `chat_session_id = $1` (and the
-- chat_sessions FK check) implies NOT NULL, so the planner still uses it.
DROP INDEX CONCURRENTLY IF EXISTS ai_calls_chat_session_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY ai_calls_chat_session_idx
  ON ai_calls (chat_session_id, created_at)
  WHERE chat_session_id IS NOT NULL;
--> statement-breakpoint

-- The chat_sessions FK the subagent session GC deletes through (SET NULL).
DROP INDEX CONCURRENTLY IF EXISTS ai_calls_parent_chat_session_id_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY ai_calls_parent_chat_session_id_idx
  ON ai_calls (parent_chat_session_id)
  WHERE parent_chat_session_id IS NOT NULL;
--> statement-breakpoint

-- audit_events had indexes only on id, entity_id and request_id.
-- `audit_events.aggregate_by_op_prefix` (`ops/security/ai_calls_by_op.ts`)
-- reads a time window of it.
DROP INDEX CONCURRENTLY IF EXISTS audit_events_created_at_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY audit_events_created_at_idx
  ON audit_events (created_at);
--> statement-breakpoint

-- The chat-image GC (`chat-image-gc-worker.ts`) periodically reads every
-- message with attachments; most messages have none.
DROP INDEX CONCURRENTLY IF EXISTS chat_messages_with_attachments_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY chat_messages_with_attachments_idx
  ON chat_messages (created_at)
  WHERE attachments IS NOT NULL;
--> statement-breakpoint

-- The chat_sessions FK the subagent session GC deletes through (SET NULL).
DROP INDEX CONCURRENTLY IF EXISTS page_edit_log_chat_session_id_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY page_edit_log_chat_session_id_idx
  ON page_edit_log (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
