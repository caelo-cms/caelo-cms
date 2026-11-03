-- SPDX-License-Identifier: MPL-2.0
--
-- 0532 — issue #1390: what a plugin's background work costs, and whether
-- its change consumer is backing off, become part of plugin health.
--
-- 2026-11-03, searchVIU production: the consent-manager's change consumer
-- ran a site-sized core read after every agent write; each one hit the
-- 60 s statement timeout and the next write's NOTIFY re-ran it at once.
-- Nothing showed that this one plugin held the database. Two columns on
-- the per-instance runtime row now say so, written with the heartbeat
-- this row already gets (never per call):
--
--   consumer_backoff  NULL while the instance's change consumer of the
--                     plugin is healthy; after a failed drain
--                     {"consecutiveFailures": n, "nextRetryAt": iso,
--                      "lastError": text} — the batch stays uncommitted and
--                     is retried then (plugin-host change-consumers.ts).
--   op_cost           the core operations the plugin called through its
--                     broker on this instance since `op_cost_since`:
--                     {"<op>": {"calls": n, "totalMs": n, "maxMs": n}}.
--
-- Reported only, never acted on: a plugin's status stays the Owner's
-- decision (CLAUDE.md §2, #1008). Expand-only: the previous image neither
-- reads nor writes the new columns, and their defaults keep its inserts
-- valid.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE plugin_runtime
  ADD COLUMN IF NOT EXISTS consumer_backoff jsonb NULL
    CHECK (consumer_backoff IS NULL OR jsonb_typeof(consumer_backoff) = 'object'),
  ADD COLUMN IF NOT EXISTS op_cost jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(op_cost) = 'object'),
  ADD COLUMN IF NOT EXISTS op_cost_since timestamptz NULL;

COMMIT;
