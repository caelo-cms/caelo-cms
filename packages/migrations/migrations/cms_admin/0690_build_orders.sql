-- SPDX-License-Identifier: MPL-2.0
--
-- 0690 — build orders (issue #1574, after #1359).
--
-- On request-billed CPU (#1361) the admin works only inside a request. A
-- Stage, a Publish live or a production build that nobody waits for in a
-- request — an agent's Stage over MCP, a button whose browser tab closed —
-- would freeze the moment its request ended. Such a build now runs inside a
-- request that a small carrier job holds open: a reporting job (0680) of
-- kind `build`, whose one report, `run`, makes the admin run the build in
-- that request and answers when it ends.
--
-- `build_orders` holds what to build, so whichever admin instance takes the
-- carrier's request can run it:
--
--   - what (`kind` + `input`): the Stage of some chats, or one of the
--     deploy ops with its input, as the person or agent asked for it;
--   - who (`actor`): the context the build runs under — the same checks
--     (a human for production, permissions) apply when it runs;
--   - its state and outcome, which the request that asked for it reads
--     while it waits (an agent: about a minute; a button: until it ends);
--   - a stop request (the operator's Stop), which the running build reads.
--
-- The id is the deploy run's id where the build has one, so "where does my
-- Stage stand" finds the order before its run row exists.
--
-- Expand-only: one new table. Runtime coordination, exempt from the change
-- journal (packages/shared/src/change-journal.ts).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS build_orders (
  id                 uuid PRIMARY KEY,
  -- What to run (admin-core build-carrier/order.ts BUILD_ORDER_KINDS).
  kind               text NOT NULL CHECK (kind IN (
                       'stage', 'deploy.trigger', 'deploy.promote',
                       'deploy.execute_proposal', 'quality_audits.publish_anyway',
                       'quality_audits.execute_proposal')),
  -- The Stage's chats, or the op's input. No credential.
  input              jsonb NOT NULL,
  -- The execution context the build runs under (actor, request, chat attribution).
  actor              jsonb NOT NULL,
  state              text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done')),
  -- Once done: { ok, value } or { ok: false, error }.
  outcome            jsonb NULL,
  -- The most seconds the build may run in its carrier's request; NULL = no
  -- limit (a self-hosted admin holds no request limit).
  max_run_seconds    integer NULL CHECK (max_run_seconds BETWEEN 1 AND 3600),
  stop_requested_at  timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz NULL,
  finished_at        timestamptz NULL,
  CONSTRAINT build_orders_done CHECK (
    (state = 'done') = (finished_at IS NOT NULL AND outcome IS NOT NULL))
);

-- The backstop's read: queued orders whose carrier never started.
CREATE INDEX IF NOT EXISTS build_orders_queued_idx
  ON build_orders (created_at) WHERE state = 'queued';
-- The clean-up of finished orders.
CREATE INDEX IF NOT EXISTS build_orders_done_idx
  ON build_orders (finished_at) WHERE state = 'done';

ALTER TABLE build_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_orders FORCE ROW LEVEL SECURITY;
-- Only the system actor writes them (the ops are system-only): the request
-- that asks for a build and the carrier's report act as it.
DROP POLICY IF EXISTS build_orders_system ON build_orders;
CREATE POLICY build_orders_system ON build_orders
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));
-- "Where does my Stage stand" (deploy.stage_status, read by people and the
-- AI) sees an order whose run has not started yet. Plugins see nothing.
DROP POLICY IF EXISTS build_orders_read ON build_orders;
CREATE POLICY build_orders_read ON build_orders FOR SELECT
  USING (caelo_setting_is('caelo.actor_kind', 'human')
         OR caelo_setting_is('caelo.actor_kind', 'ai'));

COMMIT;
