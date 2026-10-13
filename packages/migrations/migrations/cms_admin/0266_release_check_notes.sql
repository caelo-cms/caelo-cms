-- SPDX-License-Identifier: MPL-2.0
-- Issue #696 Phase 0 — Settings → Updates shows what the newest release
-- changes before the Owner upgrades. The release-check worker already
-- fetches the GitHub release; it now also keeps its notes and publish date
-- (the notes capped at 20 000 characters by the worker). NULL until the
-- first poll after this migration, and whenever the last poll failed.

ALTER TABLE release_check_cache
  ADD COLUMN IF NOT EXISTS release_notes text NULL,
  ADD COLUMN IF NOT EXISTS published_at timestamptz NULL;
