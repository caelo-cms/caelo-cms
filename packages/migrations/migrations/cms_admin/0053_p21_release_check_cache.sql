-- SPDX-License-Identifier: MPL-2.0
-- P21 ship 5 — release check cache.
--
-- Was: notifications.aggregate fetched github.com/.../releases/latest
-- inline inside the op handler's transaction. Slow GitHub held a
-- Postgres connection open for up to 5s per call → connection-pool
-- exhaustion vector under load.
--
-- Now: a background worker (apps/admin/src/hooks.server.ts) polls
-- GitHub once per hour and writes the result here. The op just reads
-- the table — pure Postgres, no network in the tx.

CREATE TABLE release_check_cache (
  id              int PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  latest_version  text         NULL,
  release_url     text         NULL,
  fetched_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT release_check_cache_singleton CHECK (id = 1)
);

ALTER TABLE release_check_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_check_cache FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS release_check_cache_authenticated_scope ON release_check_cache;
CREATE POLICY release_check_cache_authenticated_scope ON release_check_cache
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- Seed the singleton row so the worker can UPSERT-by-id without
-- caring whether it's the first run. Initial NULL/NULL means
-- notifications.aggregate reports upgradeAvailable=false until the
-- first poll lands (~1h after admin boot).
INSERT INTO release_check_cache (latest_version, release_url, fetched_at)
VALUES (NULL, NULL, '1970-01-01T00:00:00Z')
ON CONFLICT DO NOTHING;
