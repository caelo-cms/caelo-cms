-- SPDX-License-Identifier: MPL-2.0
--
-- 0378 — issue #1157: redirects sync to the hosting provider on save.
--
-- A saved redirect no longer waits for the next build: the save pushes the
-- redirects table to every deploy target that serves one (production, and
-- staging where the provider serves redirects there), computed against the
-- files of the build that target serves now. Two tables record it.
--
-- 1. `redirect_sync_state` — one row per target: which revision of the
--    redirects table the target should serve (`wanted_revision`, bumped in
--    the transaction of every redirects write) and which it serves
--    (`synced_revision`, set by a successful sync). wanted > synced means the
--    provider is behind: the sync after the save failed or has not run yet.
--    The retry worker picks those rows up after `next_attempt_at`. Written
--    by every actor that writes redirects (human, ai, plugin, system — the
--    bump runs in their transaction), so the policy mirrors `redirects`.
--
-- 2. `redirect_syncs` — the history: one row per sync attempt and target,
--    with what it did, the counts, where the plan now lives, and the error
--    of a failed attempt. Shown in Settings → Redirects; the audit log has a
--    `redirects.sync_provider` row for each attempt too. Each sync keeps the
--    newest 50 rows per target.
--
-- Existing targets start in sync (wanted = synced = 0): the upgrade itself
-- pushes nothing. The first redirects write or Publish live after it syncs
-- the whole table.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE redirect_sync_state (
  target_id        uuid PRIMARY KEY REFERENCES deploy_targets(id) ON DELETE CASCADE,
  wanted_revision  bigint NOT NULL DEFAULT 0 CHECK (wanted_revision >= 0),
  synced_revision  bigint NOT NULL DEFAULT 0 CHECK (synced_revision >= 0),
  failed_attempts  integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  next_attempt_at  timestamptz NULL,
  last_error       text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 4000),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX redirect_sync_state_behind_idx ON redirect_sync_state (next_attempt_at)
  WHERE wanted_revision > synced_revision;

CREATE TABLE redirect_syncs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id         uuid NOT NULL REFERENCES deploy_targets(id) ON DELETE CASCADE,
  trigger           text NOT NULL
    CHECK (trigger IN ('save', 'build', 'publish', 'rollback', 'retry', 'manual')),
  status            text NOT NULL
    CHECK (status IN ('applied', 'unchanged', 'not-served', 'nothing-live', 'failed')),
  revision          bigint NOT NULL CHECK (revision >= 0),
  served_run_id     uuid NULL,
  redirect_count    integer NULL CHECK (redirect_count IS NULL OR redirect_count >= 0),
  gone_count        integer NULL CHECK (gone_count IS NULL OR gone_count >= 0),
  shadowed_count    integer NULL CHECK (shadowed_count IS NULL OR shadowed_count >= 0),
  unserved_targets  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(unserved_targets) = 'array'),
  location          text NULL CHECK (location IS NULL OR char_length(location) <= 1000),
  error_message     text NULL CHECK (error_message IS NULL OR char_length(error_message) <= 4000),
  actor_id          uuid NOT NULL REFERENCES actors(id),
  request_id        text NULL CHECK (request_id IS NULL OR char_length(request_id) <= 200),
  started_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'failed') = (error_message IS NOT NULL))
);
CREATE INDEX redirect_syncs_recent_idx ON redirect_syncs (target_id, finished_at DESC);

INSERT INTO redirect_sync_state (target_id)
SELECT id FROM deploy_targets WHERE env IN ('staging', 'production')
ON CONFLICT (target_id) DO NOTHING;

ALTER TABLE redirect_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE redirect_sync_state FORCE ROW LEVEL SECURITY;
CREATE POLICY redirect_sync_state_authenticated_scope ON redirect_sync_state
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE redirect_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE redirect_syncs FORCE ROW LEVEL SECURITY;
CREATE POLICY redirect_syncs_read ON redirect_syncs FOR SELECT
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'));
-- A sync runs as `system` (after a save, the retry worker) or inside the
-- transaction of the build that changed what a target serves: a human
-- Publish live / rollback, or a Stage, which the AI may run.
CREATE POLICY redirect_syncs_insert ON redirect_syncs FOR INSERT
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'));
-- The same sync trims the history to the newest attempts per target.
CREATE POLICY redirect_syncs_delete ON redirect_syncs FOR DELETE
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'));

COMMIT;
