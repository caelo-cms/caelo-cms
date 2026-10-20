-- SPDX-License-Identifier: MPL-2.0
--
-- 0303 — updates that change the cloud setup run from Caelo (#819).
--
-- Until now an update request was always for the upgrader job, whose
-- narrow service account can only roll images. A release that raises the
-- infrastructure contract ended `needs_cloud_shell` and the Owner had to
-- run it from a terminal. Now the admin routes such a release to the
-- converge job instead: a one-shot Cloud Run job from the signed caelo-ops
-- image running as the install's existing `caelo-provisioner` account
-- (packages/provisioning/src/converge-job.ts). Both jobs claim requests
-- from the same table and narrate into the same timeline, so:
--
--   platform_update_requests  + route: which job installs the request
--                               ('app_roll' = the upgrader job, the old
--                               behaviour and the default; 'converge' = the
--                               converge job). Set by the admin when the
--                               Owner asks; the jobs never change it, so
--                               platform_updater gets no UPDATE on it.
--   platform_update_events    + the 'converge' phase (the timeline step in
--                               which the cloud setup is brought up to date).
--
-- Expand-only: a defaulted column and a widened CHECK. The previous image
-- writes no route (every row it writes is 'app_roll', which is what it is)
-- and never writes the new phase.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE platform_update_requests
  ADD COLUMN IF NOT EXISTS route text NOT NULL DEFAULT 'app_roll'
    CHECK (route IN ('app_roll', 'converge'));

-- The phase CHECK is 0267's inline column constraint (Postgres names it
-- <table>_<column>_check); recreated with 'converge' added.
ALTER TABLE platform_update_events
  DROP CONSTRAINT IF EXISTS platform_update_events_phase_check;
ALTER TABLE platform_update_events
  ADD CONSTRAINT platform_update_events_phase_check CHECK (phase IN (
    'queued', 'start', 'verify', 'assess', 'backup', 'converge', 'health-baseline',
    'migrations', 'roll', 'health', 'rollback', 'record', 'self-update', 'finish'
  ));

COMMIT;
