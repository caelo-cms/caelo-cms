-- SPDX-License-Identifier: MPL-2.0
--
-- 0920 — the job capacity ledger (issue #1776).
--
-- Every execution Caelo starts books its vCPU first and gives it back at
-- its end: every reporting-job kind, every Lighthouse batch of a quality
-- check, every capture. What does not fit waits, by class (immediate, stage,
-- background) and then first come first served (admin-core
-- job-capacity/plan.ts). Cloud Run does not arbitrate between our jobs and
-- the services that share the project's CPU quota, so the admin does.
--
-- job_capacity_bookings: one row per execution, or per job that waits for
-- one. A lead is a job's own execution (one per piece of work); a helper is
-- an extra execution of elastic work (a search index, a plugin job in
-- pieces), whose tasks claim pieces and stop after one when a job of a
-- higher class needs the room; a lighthouse row is one batch of a quality
-- check's Lighthouse runs; a capture row is one browser render.
--
--   - token_hash: a helper's own token (SHA-256), which its reports carry;
--     the attempt's token stays the lead's.
--   - lease_until: helpers, Lighthouse batches and captures that stop
--     without a word give their vCPU back when it passes (the tick's sweep);
--     a lead lives as long as its reporting_jobs row runs.
--   - reserve_vcpu: the Lighthouse share a quality check keeps free from its
--     start to its end.
--
-- job_capacity_budget: the last budget read (one row): the project's Cloud
-- Run CPU quota and the vCPU it leaves the jobs, or no limit (NULL) on a
-- self-hosted install. Every start that can wait reads it again, so a raised
-- quota counts from the next start on; the claims of running work use it.
--
-- job_pieces: the pieces of elastic work (a search index's vector shards, a
-- plugin job's pieces). A task claims the next open one for a lease, marks
-- it done, and a claim that ran out is open again, so a task that died
-- costs its piece and nothing more.
--
-- reporting_jobs.tasks (0862) is no longer written or read: an attempt runs
-- one lead task, and its width comes from helpers. A previous release still
-- reads it (as 1), so the column stays until a contract migration drops it.
--
-- Expand-only: three new tables. Runtime bookkeeping, exempt from the change
-- journal (packages/shared/src/change-journal.ts). Written only by the
-- system actor; the Owner's capacity card and the AI read the bookings.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS job_capacity_bookings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A reporting-job kind (reporting-jobs/protocol.ts) or 'capture'.
  kind           text NOT NULL CHECK (kind ~ '^[a-z][a-z_]{0,39}$'),
  -- The work it belongs to (an audit run, a Stage run, a batch run, a
  -- capture). Not a foreign key: it names a row of another table per kind.
  subject_id     uuid NOT NULL,
  -- The attempt a helper or a Lighthouse batch serves; a lead follows its
  -- work's current attempt.
  attempt        integer NULL CHECK (attempt BETWEEN 1 AND 20),
  role           text NOT NULL CHECK (role IN ('lead', 'helper', 'lighthouse', 'capture')),
  class          text NOT NULL CHECK (class IN ('immediate', 'stage', 'background')),
  vcpu_per_task  integer NOT NULL CHECK (vcpu_per_task BETWEEN 1 AND 8),
  tasks          integer NOT NULL CHECK (tasks BETWEEN 1 AND 64),
  -- A lead of elastic work: the most tasks the work may run (its pieces'
  -- tasks claim them); 1 for every other booking.
  max_tasks      integer NOT NULL DEFAULT 1 CHECK (max_tasks BETWEEN 1 AND 64),
  elastic        boolean NOT NULL DEFAULT false,
  -- What an elastic lead last said it wants (its unfinished pieces, capped).
  wanted_tasks   integer NOT NULL DEFAULT 1 CHECK (wanted_tasks BETWEEN 1 AND 64),
  reserve_vcpu   integer NOT NULL DEFAULT 0 CHECK (reserve_vcpu BETWEEN 0 AND 256),
  state          text NOT NULL CHECK (state IN ('waiting', 'running')),
  -- Why it waits, in operator words.
  waiting_reason text NULL CHECK (char_length(waiting_reason) <= 1000),
  token_hash     text NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- A helper's tasks that left (`<booking>:<index>`): a report sent again
  -- after its answer was lost (a stop, a leave) gives a task back once.
  left_workers   text[] NOT NULL DEFAULT '{}' CHECK (cardinality(left_workers) <= 64),
  execution      text NULL CHECK (char_length(execution) <= 400),
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz NULL,
  lease_until    timestamptz NULL,
  CONSTRAINT job_capacity_bookings_started CHECK ((state = 'running') = (started_at IS NOT NULL)),
  CONSTRAINT job_capacity_bookings_helper_token CHECK ((role = 'helper') = (token_hash IS NOT NULL))
);

-- One lead per piece of work: a second start finds the first.
CREATE UNIQUE INDEX IF NOT EXISTS job_capacity_bookings_lead_uidx
  ON job_capacity_bookings (kind, subject_id) WHERE role = 'lead';
-- A work's helpers and batches (release, claims, the authorize of a helper).
CREATE INDEX IF NOT EXISTS job_capacity_bookings_work_idx
  ON job_capacity_bookings (kind, subject_id, role);
-- The sweep of running leads whose work no longer runs.
CREATE INDEX IF NOT EXISTS job_capacity_bookings_state_idx
  ON job_capacity_bookings (state, role);
-- The sweep of rows whose lease passed.
CREATE INDEX IF NOT EXISTS job_capacity_bookings_lease_idx
  ON job_capacity_bookings (lease_until) WHERE lease_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_capacity_budget (
  id           smallint PRIMARY KEY CHECK (id = 1),
  -- 'quota': a Cloud Run CPU quota; 'machine': jobs inside a self-hosted admin (no limit).
  source       text NOT NULL CHECK (source IN ('quota', 'machine')),
  -- The vCPU the jobs may use; NULL when Google sets no limit.
  budget_vcpu  integer NULL CHECK (budget_vcpu >= 0),
  quota_vcpu   integer NULL CHECK (quota_vcpu >= 0),
  reserve_vcpu integer NOT NULL CHECK (reserve_vcpu >= 0),
  project_id   text NULL CHECK (char_length(project_id) <= 100),
  region       text NULL CHECK (char_length(region) <= 64),
  read_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_pieces (
  kind         text NOT NULL CHECK (kind ~ '^[a-z][a-z_]{0,39}$'),
  subject_id   uuid NOT NULL,
  -- Which part of the work (a collection, a batch operation).
  scope        text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  piece        integer NOT NULL CHECK (piece BETWEEN 0 AND 99999),
  -- A plugin piece's key, as its plan named it; NULL for an index shard.
  piece_key    text NULL CHECK (char_length(piece_key) <= 200),
  state        text NOT NULL CHECK (state IN ('open', 'claimed', 'done')),
  claimed_by   text NULL CHECK (char_length(claimed_by) <= 80),
  claim_until  timestamptz NULL,
  PRIMARY KEY (kind, subject_id, scope, piece),
  CONSTRAINT job_pieces_claim CHECK ((state = 'claimed') = (claim_until IS NOT NULL))
);

ALTER TABLE job_capacity_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_capacity_bookings FORCE ROW LEVEL SECURITY;
ALTER TABLE job_capacity_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_capacity_budget FORCE ROW LEVEL SECURITY;
ALTER TABLE job_pieces ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_pieces FORCE ROW LEVEL SECURITY;

-- The system actor books, admits and claims (the ops are system-only).
DROP POLICY IF EXISTS job_capacity_bookings_system ON job_capacity_bookings;
CREATE POLICY job_capacity_bookings_system ON job_capacity_bookings
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));
DROP POLICY IF EXISTS job_capacity_budget_system ON job_capacity_budget;
CREATE POLICY job_capacity_budget_system ON job_capacity_budget
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));
DROP POLICY IF EXISTS job_pieces_system ON job_pieces;
CREATE POLICY job_pieces_system ON job_pieces
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));

-- The Owner's capacity card (Settings → Deployments) and the AI
-- (get_stage_status, list_plugin_batches) read what runs and what waits.
-- Read only; the rows hold no credential (a helper's token is a hash).
DROP POLICY IF EXISTS job_capacity_bookings_operator_read ON job_capacity_bookings;
CREATE POLICY job_capacity_bookings_operator_read ON job_capacity_bookings FOR SELECT
  USING (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai']));
DROP POLICY IF EXISTS job_capacity_budget_operator_read ON job_capacity_budget;
CREATE POLICY job_capacity_budget_operator_read ON job_capacity_budget FOR SELECT
  USING (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai']));

COMMIT;
