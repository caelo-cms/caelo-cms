-- SPDX-License-Identifier: MPL-2.0
--
-- 0781 — issue #1728: the workers a server keeps off the schedule.
--
-- A worker whose cron croner refuses (an artifact approved under an older
-- croner, #1720) stays off the schedule while the plugin's other workers
-- run. Its plugin_errors entry is history: plugin health shows only the
-- last 7 days of it, so on a server that does not reload the plugin for a
-- week the problem disappeared while the worker stayed off. The server's
-- runtime row now carries the workers it keeps off, for as long as the row
-- is live; a load of the plugin with every pattern fixed writes an empty
-- list. Each element: { "workerName", "cron", "reason" }.
--
-- Expand only: a server of the previous release writes its rows without
-- the column, which then reads as no worker off the schedule.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE plugin_runtime
  ADD COLUMN IF NOT EXISTS unscheduled_workers jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(unscheduled_workers) = 'array');

COMMIT;
