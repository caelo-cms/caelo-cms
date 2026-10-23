-- SPDX-License-Identifier: MPL-2.0
--
-- 0346 — how long each step of a Stage / Publish live took (#1003).
--
-- A Stage of ~100 pages takes ~30 s and nothing recorded where the time
-- went, so it could not be optimised for sites 10-500x that size.
--
-- 1. deploy_runs.phase_timings: the run's steps in order, each
--    {"phase": <name>, "ms": <int>}. Top-level steps (prepare, generator,
--    lock-wait, publish, parity, select-preview, finish) add up to the run;
--    a dotted name (generator.compose, publish.upload) is a breakdown of
--    the top-level step it starts with. NULL = recorded before 0346, or a
--    run stopped before it started building (blocked by SEO / quality gate).
--
-- 2. started_at now defaults to clock_timestamp(). With now() it was the
--    start of the transaction, and deploy.trigger runs the whole build in
--    one, so started_at and finished_at were the same instant on every
--    run. The ops now set finished_at = clock_timestamp() as well.
--
-- Expand-only: a nullable column and a column default. Inherits
-- deploy_runs' existing RLS policies.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE deploy_runs
  ADD COLUMN IF NOT EXISTS phase_timings jsonb
    CHECK (phase_timings IS NULL OR jsonb_typeof(phase_timings) = 'array');

ALTER TABLE deploy_runs
  ALTER COLUMN started_at SET DEFAULT clock_timestamp();

COMMENT ON COLUMN deploy_runs.phase_timings IS
  'Steps of the run in order, [{phase, ms}]; dotted names break down the top-level step they start with. NULL = before 0346 or blocked before building.';

COMMIT;
