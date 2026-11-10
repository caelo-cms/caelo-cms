-- SPDX-License-Identifier: MPL-2.0
--
-- 0680 — reporting jobs (issue #1359, #1140 category A).
--
-- Long, bounded work (a Stage's quality audit; the site-import crawl in
-- #1360) runs in a container job of its own, not on the admin's CPU between
-- requests. The job holds no database credential: it reports to the admin by
-- an authenticated request, and that request is what gives the admin the CPU
-- to record what it reports.
--
-- `reporting_jobs` holds one row per piece of work (`kind` + the id of the
-- audit or import run it works on):
--
--   - the current attempt and the SHA-256 of the token the admin minted for
--     it. The job sends the token with every report; the admin accepts only
--     the current attempt's, so a job the backstop already replaced is
--     refused and stops.
--   - the lease. Every accepted report extends it. A job that dies stops
--     reporting, its lease runs out, and the scheduler tick's backstop starts
--     the next attempt (or, after the last one, records the work as failed
--     with the reason).
--   - a per-minute request count: a runaway job is refused, not served.
--
-- `reporting_job_uploads` carries a report too large for one request, in
-- parts, until the action that names it reads it. Parts belong to the row
-- and go with it; the attempt that wrote them is recorded so a restart drops
-- what an earlier attempt left.
--
-- Expand-only: two new tables. Runtime bookkeeping, exempt from the change
-- journal (packages/shared/src/change-journal.ts).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS reporting_jobs (
  -- The kind of work (admin-core reporting-jobs/protocol.ts REPORTING_JOB_KINDS).
  kind               text NOT NULL CHECK (kind ~ '^[a-z][a-z_]{0,39}$'),
  -- The audit run / import run the job works on. Not a foreign key: it
  -- names a row of a different table per kind. A row whose subject is gone
  -- is closed by the backstop when its lease runs out.
  subject_id         uuid NOT NULL,
  attempt            integer NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  -- SHA-256 (hex) of the current attempt's token; the token itself is
  -- stored nowhere.
  token_hash         text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  state              text NOT NULL CHECK (state IN ('running', 'done')),
  -- Where the attempt runs (a Cloud Run execution name, `in-process:<host>`).
  execution          text NULL CHECK (char_length(execution) <= 400),
  started_at         timestamptz NOT NULL DEFAULT now(),
  lease_until        timestamptz NOT NULL,
  last_report_at     timestamptz NULL,
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  window_requests    integer NOT NULL DEFAULT 0 CHECK (window_requests >= 0),
  -- Why the last attempt ended or could not start, in operator words (no
  -- credential). The backstop's final failure names it.
  last_error         text NULL CHECK (char_length(last_error) <= 2000),
  finished_at        timestamptz NULL,
  PRIMARY KEY (kind, subject_id),
  CONSTRAINT reporting_jobs_finished CHECK ((state = 'done') = (finished_at IS NOT NULL))
);

-- The backstop's read: running rows whose lease ran out, oldest first.
CREATE INDEX IF NOT EXISTS reporting_jobs_running_lease_idx
  ON reporting_jobs (kind, lease_until) WHERE state = 'running';
-- The clean-up of finished rows.
CREATE INDEX IF NOT EXISTS reporting_jobs_done_idx
  ON reporting_jobs (finished_at) WHERE state = 'done';

CREATE TABLE IF NOT EXISTS reporting_job_uploads (
  kind        text NOT NULL,
  subject_id  uuid NOT NULL,
  upload_id   uuid NOT NULL,
  part        integer NOT NULL CHECK (part BETWEEN 0 AND 63),
  attempt     integer NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  data        text NOT NULL CHECK (char_length(data) BETWEEN 1 AND 2097152),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, subject_id, upload_id, part),
  FOREIGN KEY (kind, subject_id) REFERENCES reporting_jobs (kind, subject_id) ON DELETE CASCADE
);

ALTER TABLE reporting_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE reporting_job_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_job_uploads FORCE ROW LEVEL SECURITY;
-- Only the system actor starts jobs and takes their reports (the ops are
-- system-only); no human, AI or plugin session reads or writes them.
DROP POLICY IF EXISTS reporting_jobs_system ON reporting_jobs;
CREATE POLICY reporting_jobs_system ON reporting_jobs
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));
DROP POLICY IF EXISTS reporting_job_uploads_system ON reporting_job_uploads;
CREATE POLICY reporting_job_uploads_system ON reporting_job_uploads
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));

COMMIT;
