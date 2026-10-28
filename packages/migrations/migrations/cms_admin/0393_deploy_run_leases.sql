-- SPDX-License-Identifier: MPL-2.0
--
-- 0393 — a Stage holds no database transaction while it builds (#1211).
--
-- `deploy.trigger` used to run the generator and the provider upload inside
-- one transaction: a pooled connection sat `idle in transaction` for the
-- whole Stage, and the run's own progress writes took a second connection
-- from the same pool — on production (2026-10-28) a 34 s Stage took 852 s
-- while the pool was exhausted, and the chat stayed locked (#1204, #1209).
-- Two transaction-scoped advisory locks only worked BECAUSE that transaction
-- stayed open; with short transactions per step they become lease rows:
--
--   deploy_runs.lease_expires_at — the run's liveness. A running build
--     renews it on a heartbeat. A `running` row whose lease lapsed has no
--     process behind it any more (crash, instance replaced) and is marked
--     failed by the next run, like the advisory lock it replaces told. NULL
--     for runs that still hold their transaction (Publish live, plugin-data
--     builds: they keep the per-run advisory lock until they move too).
--
--   deploy_leases — named leases that order publishes across instances.
--     'staging-publication': which staged build the staging host serves; a
--     Stage holds it from its preview upload to recording the origin,
--     Publish live and the preview keep-alive take its row lock inside
--     their transaction. The holder is the deploy run, released when the
--     run finishes or fails.
--
-- Why a lease may expire: these are not the cross-branch entity locks of
-- CLAUDE.md §2 (which never expire on a timer, so no editor's change is
-- silently overwritten). They guard a running process. A process that died
-- cannot release anything, so the lease lapses once its heartbeat stops —
-- the same rule as chat_turn_leases (0247). Expiry is judged on the
-- database clock, never an instance's wall clock.
--
-- Expand-safe: a new table and a nullable column. The previous release
-- never reads either; during a rolling update its Stage serializes on the
-- old advisory lock and the new one on the lease, which only overlap for
-- the minutes both images serve.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE deploy_runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE TABLE IF NOT EXISTS deploy_leases (
  name           text PRIMARY KEY CHECK (name IN ('staging-publication')),
  -- The run holding the lease. Free when NULL or when expires_at passed.
  holder_run_id  uuid REFERENCES deploy_runs(id) ON DELETE SET NULL,
  acquired_at    timestamptz,
  expires_at     timestamptz
);

ALTER TABLE deploy_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE deploy_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deploy_leases_authenticated_scope ON deploy_leases;
CREATE POLICY deploy_leases_authenticated_scope ON deploy_leases
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
