-- SPDX-License-Identifier: MPL-2.0
--
-- 0335 — issue #970: what each run of the operator-access sync job reported.
--
-- A Caelo user whose email has no Google account can never pass Google IAP,
-- and Google refuses to grant them (#955). The job applies everyone else and
-- used to exit 1, so /settings/users said "The last Google IAP sync failed …
-- IAP may not match this list" although only those users were affected. The
-- job now writes one row per run: which members Google refused, how many
-- other errors it hit, and (#967) why it did not hand the Google sign-in
-- client to IAP. A run whose only problem is refused members is
-- `succeeded_with_warnings` and exits 0; /settings/users names those users
-- with Delete / Change email. The admin reads the row for the execution it
-- started (or the latest one).
--
-- `execution` is the Cloud Run execution id; a retried task writes a second
-- row for the same execution, and readers take the newest. Reports older
-- than 30 days are pruned by the insert op.
--
-- The job's database role (`operator_access_reader`, 0239) was read-only.
-- This is its one write: INSERT here plus its audit row, and the prune
-- (DELETE, which needs SELECT on `finished_at` for its WHERE). Nothing else
-- of the table, and no other table, becomes writable. A compromised job could
-- only misreport its own runs — and that job already decides who passes IAP.

CREATE TABLE IF NOT EXISTS operator_access_sync_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution              text NOT NULL CHECK (length(execution) BETWEEN 1 AND 200),
  outcome                text NOT NULL
                         CHECK (outcome IN ('succeeded', 'succeeded_with_warnings', 'failed')),
  -- Emails (lower-case) Google has no account for; a JSON array of strings.
  refused_members        jsonb NOT NULL DEFAULT '[]'::jsonb
                         CHECK (jsonb_typeof(refused_members) = 'array'),
  error_count            integer NOT NULL CHECK (error_count >= 0),
  sign_in_client_problem text,
  finished_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_access_sync_runs_execution_idx
  ON operator_access_sync_runs (execution, finished_at DESC);

ALTER TABLE operator_access_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_access_sync_runs FORCE ROW LEVEL SECURITY;

-- Any authenticated session reads (the users page, the AI's
-- users.operator_access_run); only system actors write — the job, and the
-- tests acting as it.
DROP POLICY IF EXISTS operator_access_sync_runs_read ON operator_access_sync_runs;
CREATE POLICY operator_access_sync_runs_read ON operator_access_sync_runs FOR SELECT
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
DROP POLICY IF EXISTS operator_access_sync_runs_insert ON operator_access_sync_runs;
CREATE POLICY operator_access_sync_runs_insert ON operator_access_sync_runs FOR INSERT
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');
DROP POLICY IF EXISTS operator_access_sync_runs_prune ON operator_access_sync_runs;
CREATE POLICY operator_access_sync_runs_prune ON operator_access_sync_runs FOR DELETE
  USING (current_setting('caelo.actor_kind', true) = 'system'
         AND finished_at < now() - interval '30 days');

-- Same guard as 0239: an install whose admin_role could not create the role
-- (self-hosted without CREATEROLE) has no sync job and no IAP.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operator_access_reader') THEN
    EXECUTE 'GRANT INSERT (execution, outcome, refused_members, error_count, sign_in_client_problem)
      ON operator_access_sync_runs TO operator_access_reader';
    EXECUTE 'GRANT SELECT (finished_at), DELETE ON operator_access_sync_runs TO operator_access_reader';
    -- Its own audit rows (query-api recordAudit), as platform_updater (0267).
    EXECUTE 'GRANT INSERT ON audit_events TO operator_access_reader';
  END IF;
END
$$;
