-- SPDX-License-Identifier: MPL-2.0
--
-- 0113 — crawler hardening (issue #192, epic #186).
--
-- crawl_state   — checkpointed frontier (queue remainder, seen set,
--                 counters, per-URL errors) written every batch so a
--                 crashed worker RESUMES instead of restarting. NULL
--                 once the run leaves 'crawling'.
-- heartbeat_at  — liveness stamp bumped on every batch flush. The
--                 orchestrator re-claims 'crawling' runs whose
--                 heartbeat went stale (pre-#192 a crashed run sat in
--                 'crawling' forever — started_at IS NULL was the only
--                 claim condition).
-- max_pages     — cap raised 500 → 2000: the epic's target is real
--                 sites with 1000+ subpages. Batched writes keep
--                 memory bounded at any cap.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_runs ADD COLUMN crawl_state jsonb NULL;
ALTER TABLE import_runs ADD COLUMN heartbeat_at timestamptz NULL;

ALTER TABLE import_runs DROP CONSTRAINT import_runs_max_pages_check;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_max_pages_check
  CHECK (max_pages BETWEEN 1 AND 2000);

COMMIT;
