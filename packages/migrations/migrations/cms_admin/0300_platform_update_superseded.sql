-- SPDX-License-Identifier: MPL-2.0
--
-- 0300 — Settings → Updates answers "can I update, and how?" (#861, #817).
--
-- 1. `superseded`: an update request that asked the Owner to act
--    (`needs_cloud_shell`) stops asking once the install runs its target
--    release or a newer request exists — e.g. the Owner upgraded from Cloud
--    Shell, which never touches this database. The admin marks such rows
--    `superseded` (platform-update-requests.ts `supersedeRequests`, at boot
--    and on every new request); the page shows them in the history only.
--    Before, the card for an already-installed release stayed up forever.
--
-- 2. Route prediction: the release check reads the newest release's
--    manifest and notes whether it raises the infrastructure contract over
--    the running release (`latest_infra_change`), and against which release
--    that was decided (`infra_change_from`). The page uses it only while
--    `infra_change_from` is the running release, so an upgrade never leaves
--    a stale prediction behind. NULL = not known (manifest unreadable, or
--    checked before this migration): the upgrader job still decides.
--
-- Expand-only: a wider CHECK and two nullable columns. Both tables keep
-- their existing RLS policies (0053, 0267).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE platform_update_requests
  DROP CONSTRAINT IF EXISTS platform_update_requests_status_check;
ALTER TABLE platform_update_requests
  ADD CONSTRAINT platform_update_requests_status_check CHECK (status IN (
    'pending', 'running', 'succeeded', 'rolled_back', 'failed', 'refused',
    'needs_cloud_shell', 'cancelled',
    'superseded'  -- asked the Owner to act; the install moved past it since
  ));

-- 0267's unnamed table CHECK "an end state has finished_at": Postgres named
-- it platform_update_requests_check2 (third unnamed table CHECK).
ALTER TABLE platform_update_requests
  DROP CONSTRAINT IF EXISTS platform_update_requests_check2;
ALTER TABLE platform_update_requests
  DROP CONSTRAINT IF EXISTS platform_update_requests_finished_when_ended;
ALTER TABLE platform_update_requests
  ADD CONSTRAINT platform_update_requests_finished_when_ended CHECK (
    (status IN ('succeeded', 'rolled_back', 'failed', 'refused', 'needs_cloud_shell',
                'cancelled', 'superseded'))
    <= (finished_at IS NOT NULL)
  );

ALTER TABLE release_check_cache
  ADD COLUMN IF NOT EXISTS latest_infra_change boolean NULL,
  ADD COLUMN IF NOT EXISTS infra_change_from text NULL
    CHECK (char_length(infra_change_from) <= 64);

COMMENT ON COLUMN release_check_cache.latest_infra_change IS
  'The newest release raises the infrastructure contract over infra_change_from (from the release manifests); NULL = not known.';
COMMENT ON COLUMN release_check_cache.infra_change_from IS
  'The running release latest_infra_change was decided against; the page ignores the prediction for any other release.';

COMMIT;
