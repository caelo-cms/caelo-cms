-- SPDX-License-Identifier: MPL-2.0
--
-- 0165 — AI-filed bug reports.
--
-- Live-e2e forensics keep surfacing moments where the AI itself diagnoses a
-- product defect mid-task (run B4: "the selector-scoped screenshot seems to
-- be returning the full page render rather than a true crop") — and that
-- diagnosis previously lived only in a debug wire log. The `bug_report` tool
-- gives the AI a first-class place to file it: report once, keep working when
-- a workaround exists, abort (and say so) only when the bug blocks the task.
--
-- The table is BOTH an info source (operators + maintainers triage rows via
-- `ai_bug_reports.list`) and a metric (reports-per-run in the e2e metrics;
-- a rising count on a scenario is a regression signal even while the suite
-- stays green, because the AI is routing around defects instead of failing).
--
-- Append-only telemetry like ai_moduleize_attempts: chat_session_id nullable
-- + no FK (background/import runs file too); actor FK for attribution.

CREATE TABLE ai_bug_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  chat_session_id  uuid,
  actor_id         uuid NOT NULL REFERENCES actors(id),
  title            text NOT NULL,
  -- What the AI observed vs. what the surface promised — the triage core.
  what_happened    text NOT NULL,
  expected         text NOT NULL,
  -- The tool the AI suspects (free text: tool name, op, or surface).
  suspected_tool   text,
  -- Optional raw evidence: the tool result / render excerpt that led to the
  -- diagnosis, so triage doesn't need the original wire log.
  evidence         text,
  severity         text NOT NULL DEFAULT 'degraded'
                     CHECK (severity IN ('blocking', 'degraded', 'cosmetic')),
  -- true = the AI could NOT work around it and aborted the task.
  blocked_task     boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'triaged', 'fixed', 'invalid'))
);

--> statement-breakpoint

CREATE INDEX ai_bug_reports_status_idx ON ai_bug_reports (status, created_at);

--> statement-breakpoint

-- RLS: authenticated-scope, FORCEd, fails closed on an unset GUC — the same
-- inline pattern as ai_moduleize_attempts (0163).
ALTER TABLE ai_bug_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_bug_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_bug_reports_authenticated_scope ON ai_bug_reports;
CREATE POLICY ai_bug_reports_authenticated_scope ON ai_bug_reports
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
