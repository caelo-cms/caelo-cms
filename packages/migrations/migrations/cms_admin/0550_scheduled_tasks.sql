-- SPDX-License-Identifier: MPL-2.0
--
-- 0550 — the scheduler tick's due-table (issue #1140).
--
-- The admin does periodic work only inside a request: one scheduler (Cloud
-- Scheduler on Google Cloud, a compose service on self-hosted) calls
-- `POST /api/internal/scheduler/tick` every few minutes, and the tick runs
-- what is due. Each task keeps its own cadence here, so the tick's interval
-- (an install knob, 1–15 minutes) only bounds how late a task can run.
--
-- One row per task: the core maintenance tasks (`core:<name>`) and every
-- plugin worker (`plugin:<slug>/<worker>`). Rows are created by the first
-- tick that knows the task; a task that no longer exists keeps its row,
-- which only records when it last ran.
--
-- Several admin instances may tick at once (Cloud Run scales out, a second
-- scheduler retry overlaps): a task is claimed by one UPDATE whose WHERE
-- requires it to be due and unleased, so concurrent claims serialise on the
-- row and all but one find nothing to claim. A lease that outlives its
-- holder (the instance died mid-task) expires and the next tick runs the
-- task again.
--
-- Expand-only: a new table. Runtime bookkeeping, exempt from the change
-- journal (packages/shared/src/change-journal.ts).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  -- `core:<task>` or `plugin:<slug>/<worker name>` (the SDK's limits: a
  -- 120-character slug and worker name).
  task_key          text PRIMARY KEY
                    CHECK (task_key ~ '^(core:[a-z0-9_-]{1,80}|plugin:[a-z][a-z0-9-]{0,119}/[^[:cntrl:]/]{1,120})$'),
  -- When the task is due next. A new row is due at once.
  next_due_at       timestamptz NOT NULL DEFAULT now(),
  -- Which tick holds the task, and until when. Both set or both unset.
  lease_holder      text NULL CHECK (char_length(lease_holder) BETWEEN 1 AND 200),
  lease_until       timestamptz NULL,
  last_started_at   timestamptz NULL,
  last_finished_at  timestamptz NULL,
  last_outcome      text NULL CHECK (last_outcome IN ('ok', 'failed')),
  -- Why the last run failed, in the task's own words (no credential).
  last_error        text NULL CHECK (char_length(last_error) <= 2000),
  last_duration_ms  integer NULL CHECK (last_duration_ms >= 0),
  CONSTRAINT scheduled_tasks_lease_pair CHECK ((lease_holder IS NULL) = (lease_until IS NULL))
);

ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
-- Only the system actor runs the tick (the ops are system-only); no human,
-- AI or plugin session reads or writes the due-table.
DROP POLICY IF EXISTS scheduled_tasks_system ON scheduled_tasks;
CREATE POLICY scheduled_tasks_system ON scheduled_tasks
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));

COMMIT;
