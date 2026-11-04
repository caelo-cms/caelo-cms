-- SPDX-License-Identifier: MPL-2.0
--
-- 0600 — where the build staging serves lies (issue #1330, gateway hardening
-- P3b-2; with #1331 the cutover).
--
-- Staging is served by its own gateway from private staging storage, which
-- always holds complete builds (decision 2026-11-04, D1): two slots on the
-- cloud providers (`_slots/a/`, `_slots/b/` of the staging bucket), the run's
-- build directory on a self-hosted install. A Stage syncs the slot staging
-- does NOT serve and then points `served_location` at it, in the same
-- transaction that records `origin_run_id`; the 0281 trigger on this table
-- makes the drain publish both into cms_public_staging
-- (`published_staging_site`). A half-synced slot is never served.
--
-- `origin_url` (a Firebase preview channel's origin) is no longer written:
-- preview channels are gone (#1331). The cms_public copy of
-- `published_staging_access` keeps the column one release longer, so a
-- rolled-back gateway still starts, and loses it with that table.
--
-- No build lies in a slot yet on an existing install, so the served run is
-- cleared too: staging says "nothing staged" (and Settings says Stage once)
-- until the first Stage after the update fills a slot.

ALTER TABLE staging_access ADD COLUMN IF NOT EXISTS served_location text NULL
  CHECK (served_location IS NULL OR served_location ~ '^[A-Za-z0-9_./-]{1,200}$');

UPDATE staging_access SET origin_url = NULL, origin_run_id = NULL
  WHERE id = 1 AND served_location IS NULL AND (origin_url IS NOT NULL OR origin_run_id IS NOT NULL);
