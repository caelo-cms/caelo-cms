-- SPDX-License-Identifier: MPL-2.0
--
-- P5.2 — three small chat-runner additions:
--
-- 1. chat_messages.status — 'complete' | 'interrupted'. Defaults to
--    'complete'; set to 'interrupted' when the SSE handler observes the
--    request abort signal mid-stream so the UI can flag "this assistant
--    turn was cut short" instead of silently truncating.
--
-- 2. chat_tool_results — small dedup table keyed by
--    (chat_session_id, tool_call_id). The chat-runner consults it before
--    dispatching a tool; if a row exists the cached result is returned
--    instead of re-executing the handler. Stops the rare case where a
--    chat-runner loop retry double-executes an `edit_module` call.
--
-- 3. Partial-publish semantics live entirely in the publish op (P5.2 #5);
--    no schema change required because the merge filter is just an
--    `entity_id IN (...)` extension to the existing DISTINCT ON query.

ALTER TABLE chat_messages
  ADD COLUMN status text NOT NULL DEFAULT 'complete'
    CHECK (status IN ('complete', 'interrupted'));

--> statement-breakpoint

CREATE TABLE chat_tool_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  tool_call_id    text NOT NULL,
  tool_name       text NOT NULL,
  result_ok       boolean NOT NULL,
  result_content  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_session_id, tool_call_id)
);

CREATE INDEX chat_tool_results_session_idx ON chat_tool_results (chat_session_id, created_at);

ALTER TABLE chat_tool_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_tool_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_tool_results_authenticated_scope ON chat_tool_results;
CREATE POLICY chat_tool_results_authenticated_scope ON chat_tool_results
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
