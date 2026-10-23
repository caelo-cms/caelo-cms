-- SPDX-License-Identifier: MPL-2.0
--
-- 0344 — issue #1008: a plugin's runtime state is no longer its status.
--
-- `plugins.status` records a decision: the Owner's (active / disabled) or
-- the review's (draft / awaiting_activation / rejected). Until now the host
-- also wrote `failed` into it whenever a load threw on one instance, which
-- switched a plugin off for the whole site — on 2026-10-22 a concurrent
-- boot race did exactly that to an active plugin, and a Tier-1 plugin in
-- `failed` had no way back (activation accepts only awaiting/disabled).
-- Decision (2026-10-23): a plugin is never switched off automatically.
--
-- 1. Existing `failed` rows go back to the decision they overwrote, read from
--    the markers that decision left: rejected -> `rejected`, disabled ->
--    `disabled`, activated -> `active`, otherwise `awaiting_activation`. The stored load error moves to
--    `plugin_errors`. `failed` leaves the status CHECK. Not a contract
--    migration: the previous image never reads `failed`, and its one write
--    of it (`markPluginFailed`) is already wrapped in a catch, so that write
--    now fails the CHECK and leaves the Owner's decision standing — the
--    behaviour this migration exists for.
--
-- 2. `plugin_errors` — every plugin problem the host sees, deduplicated by
--    fingerprint per plugin: when (first/last), how often, where (instance,
--    revision), in which phase, and whose fault (class). `plugin_id` is
--    NULL for a plugin whose row could not be read or written (a broken
--    manifest is recorded by slug). Deleted with the plugin row.
--
-- 3. `plugin_runtime` — per running instance and plugin, whether the plugin
--    is loaded there or failed to load, with a heartbeat. Health shown to
--    the Owner and the AI is computed from the rows whose heartbeat is
--    recent, so a stopped instance stops counting on its own.
--
-- Both tables are written by the plugin host as `system` and read by
-- `plugins.list` / `plugins.get` (any actor kind: the AI needs to see
-- plugin health to explain it). Nobody else writes them.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE plugin_errors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_slug     text NOT NULL CHECK (plugin_slug ~ '^[a-z][a-z0-9-]*$' OR plugin_slug ~ '^<[a-z0-9-]+>$'),
  plugin_id       uuid NULL REFERENCES plugins(id) ON DELETE CASCADE,
  fingerprint     text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  phase           text NOT NULL
    CHECK (phase IN ('verify', 'register', 'provision', 'activate', 'operation', 'worker', 'render')),
  error_class     text NOT NULL CHECK (error_class IN ('transient', 'plugin', 'core')),
  message         text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
  occurrences     integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_instance   text NOT NULL CHECK (char_length(last_instance) BETWEEN 1 AND 200),
  last_revision   text NULL CHECK (last_revision IS NULL OR char_length(last_revision) <= 200),
  bug_report_id   uuid NULL REFERENCES ai_bug_reports(id) ON DELETE SET NULL,
  -- Which occurrence files the core defect with the bug intake: claimed
  -- atomically by the upsert, cleared when the report is linked or the
  -- intake refused it. Without it, instances booting into the same core
  -- failure would each file a blocking report before any was linked.
  bug_intake_claim      uuid NULL,
  bug_intake_claimed_at timestamptz NULL,
  CHECK ((bug_intake_claim IS NULL) = (bug_intake_claimed_at IS NULL)),
  UNIQUE (plugin_slug, fingerprint)
);
CREATE INDEX plugin_errors_recent_idx ON plugin_errors (plugin_slug, last_seen_at DESC);

CREATE TABLE plugin_runtime (
  instance_id   text NOT NULL CHECK (char_length(instance_id) BETWEEN 1 AND 200),
  plugin_slug   text NOT NULL CHECK (plugin_slug ~ '^[a-z][a-z0-9-]*$'),
  revision      text NULL CHECK (revision IS NULL OR char_length(revision) <= 200),
  state         text NOT NULL CHECK (state IN ('loaded', 'error')),
  -- CASCADE, not SET NULL: an `error` row without its error would break
  -- the CHECK below, and the error only goes when its plugin is uninstalled.
  error_id      uuid NULL REFERENCES plugin_errors(id) ON DELETE CASCADE,
  -- Order of this instance's outcomes for the plugin (boot epoch * 10^6 +
  -- a per-process counter): the upsert only replaces an older outcome, so a
  -- retried write that commits late never overwrites a newer one.
  outcome_seq   bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  heartbeat_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, plugin_slug),
  CHECK (state = 'loaded' OR error_id IS NOT NULL)
);
CREATE INDEX plugin_runtime_fresh_idx ON plugin_runtime (plugin_slug, heartbeat_at DESC);

ALTER TABLE plugin_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_errors FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_errors_read ON plugin_errors FOR SELECT
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'));
CREATE POLICY plugin_errors_write ON plugin_errors
  USING (current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

ALTER TABLE plugin_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_runtime FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_runtime_read ON plugin_runtime FOR SELECT
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'));
CREATE POLICY plugin_runtime_write ON plugin_runtime
  USING (current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

-- (1) Give back the decisions `failed` overwrote, keeping the error.
INSERT INTO plugin_errors
  (plugin_slug, plugin_id, fingerprint, phase, error_class, message, last_instance)
SELECT p.slug, p.id,
       encode(sha256(convert_to('legacy-failed:' || p.slug, 'UTF8')), 'hex'),
       'register', 'core',
       left(coalesce(nullif(p.validation_errors #>> '{0,hint}', ''),
                     'load failed before #1008 (no reason recorded)'), 4000),
       'migration-0344'
FROM plugins p
WHERE p.status = 'failed';

UPDATE plugins
SET status = CASE
      WHEN rejected_at IS NOT NULL THEN 'rejected'
      WHEN disabled_at IS NOT NULL THEN 'disabled'
      WHEN activated_at IS NOT NULL THEN 'active'
      ELSE 'awaiting_activation'
    END,
    validation_errors = '[]'::jsonb,
    updated_at = now()
WHERE status = 'failed';

ALTER TABLE plugins DROP CONSTRAINT plugins_status_check;
ALTER TABLE plugins ADD CONSTRAINT plugins_status_check
  CHECK (status IN ('draft', 'awaiting_activation', 'active', 'disabled', 'rejected'));

COMMIT;
