-- SPDX-License-Identifier: MPL-2.0
--
-- 0332 — "Skip this time" for a scheduled automatic install, and the
-- Owner's to-do for a breaking release (#868).
--
-- 1. platform_update_scheduler.skipped_version / skipped_by / skipped_at:
--    the release whose automatic install the Owner skipped in Settings →
--    Updates (`platform_updates.skip_scheduled`, password-confirmed). The
--    scheduler does not install or schedule that version on its own; it
--    still offers it, and a newer release installs automatically again
--    (shared auto-update.ts). One skip at a time: skipping another release
--    replaces it. On the scheduler row, not the policy: it is a decision
--    about one release, not a setting, and changing the policy keeps it.
--
-- 2. release_check_cache.latest_owner_action: the newest release's
--    `ownerAction` from its release manifest — what the Owner has to do for
--    its breaking change, shown under "Before you update". NULL = the
--    release declares none (no breaking change, or a release from before
--    the field) or its manifest could not be read.
--
-- Expand-only: nullable columns. Both tables keep their RLS policies
-- (0271, 0053).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE platform_update_scheduler
  ADD COLUMN IF NOT EXISTS skipped_version text NULL
    CHECK (skipped_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'),
  ADD COLUMN IF NOT EXISTS skipped_by uuid NULL REFERENCES actors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS skipped_at timestamptz NULL;
-- Who and when only make sense with a skipped release.
ALTER TABLE platform_update_scheduler
  ADD CONSTRAINT platform_update_scheduler_skip_fields
  CHECK ((skipped_version IS NULL) = (skipped_at IS NULL)
         AND (skipped_version IS NOT NULL OR skipped_by IS NULL));

ALTER TABLE release_check_cache
  ADD COLUMN IF NOT EXISTS latest_owner_action text NULL
    CHECK (char_length(latest_owner_action) BETWEEN 1 AND 300);

COMMENT ON COLUMN platform_update_scheduler.skipped_version IS
  'The release whose automatic install the Owner skipped (#868); the scheduler offers it instead of installing it. NULL = none.';
COMMENT ON COLUMN release_check_cache.latest_owner_action IS
  'The newest release''s ownerAction from its manifest: what the Owner must do for its breaking change. NULL = none declared or unknown.';

COMMIT;
