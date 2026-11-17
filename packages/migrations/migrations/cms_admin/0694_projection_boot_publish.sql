-- SPDX-License-Identifier: MPL-2.0
--
-- 0694 — what the last full publish of an admin covered (issue #1633).
--
-- Every admin instance published the whole gateway projection when it
-- booted, and requests waited for it. Most of that work repeats the
-- migration job's publish, which runs after every migration. What only an
-- admin can add is the visitor projections of every plugin it loaded (a
-- runtime-installed one included) and the staging gate key. An admin now
-- publishes everything at boot only when those inputs differ from what the
-- last full publish of an admin covered, or an environment has no frozen
-- release state yet; otherwise it drains the outbox.
--
--   projection_boot_publish  one row: the sha256 of those inputs
--     (admin-core public-projection.ts `bootPublishInputsDigest`; the gate
--     key enters only as its own sha256) and when it was published.
--
-- Expand-only: a new table the previous release never reads. Without its
-- row an admin publishes everything at boot, as before.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE projection_boot_publish (
  id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  inputs_digest  text NOT NULL CHECK (inputs_digest ~ '^[0-9a-f]{64}$'),
  published_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE projection_boot_publish ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_boot_publish FORCE ROW LEVEL SECURITY;
CREATE POLICY projection_boot_publish_system ON projection_boot_publish
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));

COMMIT;
