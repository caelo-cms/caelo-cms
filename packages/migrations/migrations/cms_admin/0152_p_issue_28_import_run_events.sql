-- SPDX-License-Identifier: MPL-2.0
--
-- 0152 — issue #28: run-scoped ERROR/WARNING LEDGER for website migrations.
--
-- Before this table the only migration-error surfaces were
-- import_runs.error_message (a single last-fatal string) and
-- import_pages.diff_status (per-page pass/warn/fail). Neither is a
-- CONSOLIDATED list of every problem hit across a run — the operator
-- explicitly asked for all migration errors/warnings to be tracked and
-- reviewable in the closing run report.
--
-- import_run_events is that ledger: one row per problem, appended as the
-- migration runs (a skipped media asset, a page that fails the fidelity
-- gate, a crawl fetch error, …). imports.get_run_report reads them back
-- ordered by severity so nothing that went wrong is silently dropped
-- (CLAUDE.md §2 no-fallbacks — surface, don't swallow).

CREATE TABLE IF NOT EXISTS import_run_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  severity   text NOT NULL CHECK (severity IN ('warning', 'error', 'info')),
  -- Which migration stage emitted the event. Free-ish text (not a CHECK)
  -- so a new stage can log without a schema change; the known set today is
  -- crawl | media | fidelity | inventory | compose.
  phase      text NULL,
  message    text NOT NULL,
  -- Structured payload for the surface (skipped asset url+reason, diff pct,
  -- etc.). jsonb so the report can render specifics without parsing message.
  detail     jsonb NULL,
  -- Optional link to the import_pages row the event concerns. Deliberately
  -- NOT a FK: an event may reference either a staging import_pages id or a
  -- composed pages id depending on the emitter, and the ledger must survive
  -- a page row being cleaned up.
  page_id    uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_run_events_run_idx
  ON import_run_events (run_id, created_at);

-- RLS mirrors import_runs / import_pages (0044_p14_imports.sql) EXACTLY:
-- enable + FORCE row level security, one policy that admits any request
-- carrying a non-empty caelo.actor_kind GUC (the authenticated-actor scope).
ALTER TABLE import_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_run_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_run_events_authenticated_scope ON import_run_events;
CREATE POLICY import_run_events_authenticated_scope ON import_run_events
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
