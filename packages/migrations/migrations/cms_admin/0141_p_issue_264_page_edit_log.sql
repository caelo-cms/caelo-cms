-- SPDX-License-Identifier: MPL-2.0
--
-- 0141 — per-page edit LOG (issue #264, orchestrator/task-subagent slice).
--
-- Run #7 proved a single chat session cannot carry a real migration: the
-- transcript that held every decision, operator answer, and rebuild detail
-- had to be dragged through every provider call until the session died
-- (#261). The fix is to make a page's WORK HISTORY durable and disposable-
-- from-context: this table records why a page was edited, what decisions
-- were taken, which operator answers shaped it, and what open questions
-- remain. A later chat — or a fresh subagent that starts with no memory of
-- the originating chat — reads the page's log instead of the whole
-- transcript.
--
-- Distinct from `site_ai_memory` (proposal-gated, learned BEHAVIOUR): the
-- page log is append-only FACT, not something the AI should be trusted to
-- edit or the operator asked to review. So it is UNGATED — every actor kind
-- appends directly, like the audit log or import notes. Nothing rewrites or
-- deletes an entry; history only grows.
--
-- RLS is authenticated-scope (any signed-in actor), matching the other
-- shared decision-support tables (design_manifests) rather than per-actor
-- scope: the log is deliberately CROSS-actor context — a subagent must read
-- what a different actor logged on the same page. FORCEd so owners are
-- scoped too, per CLAUDE.md §2.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE page_edit_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id          uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  -- Nullable: work can originate outside a chat (background worker, MCP).
  -- SET NULL on session delete so releasing a chat/lease never erases the
  -- intent the log preserves (issue #264 lease semantics).
  chat_session_id  uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  actor_id         uuid NOT NULL REFERENCES actors(id),
  actor_kind       text NOT NULL,
  entry_kind       text NOT NULL CHECK (
    entry_kind IN ('edited', 'decision', 'operator_answer', 'open_question', 'rebuilt', 'note')
  ),
  summary          text NOT NULL,
  detail           jsonb NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The only read pattern is "this page's log, newest first".
CREATE INDEX page_edit_log_page_created_idx ON page_edit_log (page_id, created_at DESC);

ALTER TABLE page_edit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_edit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_edit_log_authenticated_scope ON page_edit_log;
CREATE POLICY page_edit_log_authenticated_scope ON page_edit_log
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
