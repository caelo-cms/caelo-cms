-- SPDX-License-Identifier: MPL-2.0
--
-- Epic #1644 (R5, issue #1646) — plugin batch runs.
--
-- plugin_batch_runs   one run of a plugin's declared batch operation: who or
--                     what started it (activation, an operator, a Stage, its
--                     schedule), its input, where it is, and how it ended.
--                     The `plugin_batch` reporting job runs it; its rows in
--                     reporting_jobs hold the attempts and leases.
--
-- At most one run of one operation is queued or running at a time (the
-- partial unique index): a second start of the same batch is refused with
-- the run that is already going.
--
-- Expand-only: a new table the previous release does not read.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE plugin_batch_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id      uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  operation      text NOT NULL CHECK (operation ~ '^[A-Za-z_][A-Za-z0-9_]{0,119}$'),
  -- The version the run was started for; a plugin updated meanwhile stops it.
  plugin_version text NOT NULL,
  trigger        text NOT NULL CHECK (trigger IN ('activation', 'operator', 'stage', 'schedule')),
  input          jsonb NOT NULL DEFAULT '{}'::jsonb,
  stage_run_id   uuid NULL REFERENCES deploy_runs(id) ON DELETE SET NULL,
  state          text NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued', 'running', 'completed', 'failed', 'stopped')),
  result         jsonb NULL,
  error          text NULL,
  requested_by   uuid NULL REFERENCES actors(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz NULL,
  finished_at    timestamptz NULL
);

CREATE UNIQUE INDEX plugin_batch_runs_one_active_idx
  ON plugin_batch_runs (plugin_id, operation) WHERE state IN ('queued', 'running');
CREATE INDEX plugin_batch_runs_plugin_idx ON plugin_batch_runs (plugin_id, created_at DESC);
CREATE INDEX plugin_batch_runs_queued_idx ON plugin_batch_runs (created_at) WHERE state = 'queued';
CREATE INDEX plugin_batch_runs_stage_run_idx ON plugin_batch_runs (stage_run_id);
CREATE INDEX plugin_batch_runs_requested_by_idx ON plugin_batch_runs (requested_by);

ALTER TABLE plugin_batch_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_batch_runs FORCE ROW LEVEL SECURITY;
-- The runs are written by the host's system operations only.
CREATE POLICY plugin_batch_runs_system_scope ON plugin_batch_runs
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));
-- Which batches ran and how they ended is no secret to the people and the
-- AI running the site (Settings, the plugin's page, the AI's list tool). A
-- run's input and result are the plugin's data: a plugin reads its own runs
-- only, never another plugin's.
CREATE POLICY plugin_batch_runs_operator_read ON plugin_batch_runs FOR SELECT
  USING (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system']));
CREATE POLICY plugin_batch_runs_own_plugin_read ON plugin_batch_runs FOR SELECT
  USING (caelo_setting_is('caelo.actor_kind', 'plugin') AND (plugin_id)::text = current_setting('caelo.plugin_id', true));

-- A person or the AI starts a batch that declares the operator trigger
-- (plugin_batches.start checks the declaration and the grant) and stops one
-- that has not ended; everything else about a run is the system's.
CREATE POLICY plugin_batch_runs_operator_start ON plugin_batch_runs FOR INSERT
  WITH CHECK (
    caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai'])
    AND trigger = 'operator' AND state = 'queued'
    AND result IS NULL AND error IS NULL AND started_at IS NULL AND finished_at IS NULL
  );
CREATE POLICY plugin_batch_runs_operator_stop ON plugin_batch_runs FOR UPDATE
  USING (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai']) AND state IN ('queued', 'running'))
  WITH CHECK (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai']) AND state = 'stopped');

COMMIT;
