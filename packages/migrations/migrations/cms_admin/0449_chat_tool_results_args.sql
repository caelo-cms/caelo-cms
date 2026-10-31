-- SPDX-License-Identifier: MPL-2.0
--
-- 0449 — #1275: a failed write tool call is kept for a patch.
--
-- When a write tool call fails validation (a wrong page type, an unknown
-- $ref, a bad field value, a schema error, a stale version), the AI used
-- to re-emit the WHOLE call — every module's HTML again — to fix one
-- value. The call's normalized arguments are now kept with its existing
-- dedup row, and `retry_tool_call({toolCallId, set?, remove?, replace?})`
-- re-dispatches them with a small patch through the normal pipeline.
--
--   args            the call's normalized arguments; set only for a kept
--                   failure (a fixable failure kind of a write tool with
--                   non-empty arguments), NULL for every other row and
--                   cleared again when a retry succeeds. Same table, same
--                   lifetime as the chat (ON DELETE CASCADE): no TTL, no
--                   GC worker.
--   args_actor_id   the operator the call ran for (the chat's human, or
--                   the MCP token's user). Only that actor reads a kept
--                   call back (policy below), so another actor cannot
--                   retry it even inside the same session.
--   retry_claimed_at  set while a retry runs (atomic claim: one of two
--                   parallel retries of the same id wins); cleared when
--                   it ends, with the new errors or with the success.
--
-- The row's tool_name / result_ok / result_content follow the latest
-- attempt, so a replay of the original call id (the dedup the table
-- exists for) never runs a call a retry already applied.

ALTER TABLE chat_tool_results
  ADD COLUMN args jsonb NULL,
  ADD COLUMN args_actor_id uuid NULL REFERENCES actors(id) ON DELETE CASCADE,
  ADD COLUMN retry_claimed_at timestamptz NULL;

--> statement-breakpoint

ALTER TABLE chat_tool_results
  ADD CONSTRAINT chat_tool_results_args_actor
    CHECK (args IS NULL OR args_actor_id IS NOT NULL);

--> statement-breakpoint

-- A kept call is the operator's own: RESTRICTIVE, so it narrows the
-- existing authenticated-scope policy instead of widening it. Rows that
-- keep nothing (args IS NULL) stay readable exactly as before (the dedup
-- lookup); `system` keeps its usual bypass.
DROP POLICY IF EXISTS chat_tool_results_kept_call_owner ON chat_tool_results;
CREATE POLICY chat_tool_results_kept_call_owner ON chat_tool_results
  AS RESTRICTIVE
  USING (
    args IS NULL
    OR args_actor_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
    OR current_setting('caelo.actor_kind', true) = 'system'
  )
  WITH CHECK (
    args IS NULL
    OR args_actor_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
    OR current_setting('caelo.actor_kind', true) = 'system'
  );
