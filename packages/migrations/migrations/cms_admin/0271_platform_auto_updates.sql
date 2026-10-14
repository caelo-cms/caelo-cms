-- SPDX-License-Identifier: MPL-2.0
--
-- 0271 — automatic Caelo updates (epic #696 Phase 5).
--
-- 0267 stored the Owner's update policy and let the upgrader job refuse
-- what it forbids. This migration adds what the scheduler inside the admin
-- needs to queue automatic installs from it, and what tells the Owner about
-- them:
--
--   platform_update_policy        + security_soak_hours: the soak period for
--                                   releases whose signed manifest names a
--                                   published GitHub Security Advisory
--                                   (default 2 h; other releases keep
--                                   soak_hours, default 24 h).
--                                 + paused_until / paused_by: the Owner's own
--                                   pause (until a time, or indefinitely);
--                                   paused_by NULL = paused by the upgrader
--                                   after a failed automatic install.
--   platform_update_requests      + auto_basis: why the scheduler queued an
--                                   automatic install (security / patch /
--                                   minor). The job re-checks it against the
--                                   signed manifest, so a forged "security"
--                                   claim cannot shorten the soak period.
--                                 + one automatic attempt per release, ever.
--   platform_update_scheduler     singleton: the scheduler's lease (one admin
--                                   instance decides per interval) and its
--                                   last decision, for the page and the AI.
--   platform_update_notifications outbox of the Owner's update emails, one
--                                   row per event (deduplicated), with how
--                                   delivery went.
--
-- Expand-only: new nullable/defaulted columns, new tables, new indexes.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE platform_update_policy
  ADD COLUMN IF NOT EXISTS security_soak_hours integer NOT NULL DEFAULT 2
    CHECK (security_soak_hours BETWEEN 0 AND 720),
  ADD COLUMN IF NOT EXISTS paused_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS paused_by uuid NULL REFERENCES actors(id) ON DELETE SET NULL;
-- A pause end or a pausing Owner only make sense while paused.
ALTER TABLE platform_update_policy
  ADD CONSTRAINT platform_update_policy_pause_fields
  CHECK (paused OR (paused_until IS NULL AND paused_by IS NULL));

ALTER TABLE platform_update_requests
  ADD COLUMN IF NOT EXISTS auto_basis text NULL
    CHECK (auto_basis IN ('security', 'patch', 'minor'));
ALTER TABLE platform_update_requests
  ADD CONSTRAINT platform_update_requests_auto_basis_only_auto
  CHECK (auto_basis IS NULL OR trigger = 'auto');
-- The scheduler tries each release once. A refused, failed or cancelled
-- automatic attempt is not retried on its own: the Owner was told why and
-- installs it from Settings → Updates.
CREATE UNIQUE INDEX IF NOT EXISTS platform_update_requests_one_auto_per_version
  ON platform_update_requests (target_version)
  WHERE trigger = 'auto';

CREATE TABLE platform_update_scheduler (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Which admin instance ran the last tick and when: a tick only runs when
  -- the previous one is older than the interval, so N instances make one
  -- decision per interval, not N.
  lease_holder     text NULL CHECK (char_length(lease_holder) <= 200),
  last_run_at      timestamptz NULL,
  -- The last decision, in plain words (Settings → Updates and the AI show it).
  last_version     text NULL CHECK (char_length(last_version) <= 64),
  last_action      text NULL CHECK (last_action IN (
                     'none', 'notify', 'wait', 'install', 'manual', 'needs_cloud_shell', 'blocked'
                   )),
  last_reason      text NULL CHECK (char_length(last_reason) <= 2000),
  -- When a waiting release becomes installable (soak over / window opens).
  last_wait_until  timestamptz NULL
);
INSERT INTO platform_update_scheduler (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE platform_update_notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN (
                     'available', 'scheduled', 'installed', 'failed', 'needs_cloud_shell'
                   )),
  target_version   text NOT NULL
                   CHECK (target_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'),
  request_id       uuid NULL REFERENCES platform_update_requests(id) ON DELETE SET NULL,
  -- One notification per event, however many admin instances see it.
  dedupe_key       text NOT NULL UNIQUE CHECK (char_length(dedupe_key) <= 300),
  subject          text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 300),
  body             text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivery_status  text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN (
                     'pending',        -- not sent yet
                     'sending',        -- an instance claimed it
                     'sent',           -- the email transport accepted it
                     'failed',         -- the transport refused it (delivery_detail says why)
                     'no_transport',   -- no email transport configured (Settings → Email)
                     'no_recipients'   -- no Owner with an email address
                   )),
  delivery_detail  text NULL CHECK (char_length(delivery_detail) <= 2000),
  recipients       text[] NOT NULL DEFAULT '{}',
  claimed_at       timestamptz NULL,
  delivered_at     timestamptz NULL
);
CREATE INDEX platform_update_notifications_recent
  ON platform_update_notifications (created_at DESC);
CREATE INDEX platform_update_notifications_undelivered
  ON platform_update_notifications (created_at)
  WHERE delivery_status IN ('pending', 'sending');

ALTER TABLE platform_update_scheduler ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_update_scheduler FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_update_scheduler_authenticated_scope ON platform_update_scheduler
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE platform_update_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_update_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_update_notifications_authenticated_scope ON platform_update_notifications
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
