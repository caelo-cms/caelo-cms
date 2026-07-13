-- SPDX-License-Identifier: MPL-2.0
--
-- 0136 — site-migrate: publish migrated pages in bulk BEFORE any
-- staging preview (migration run #9 R10, 2026-07-13, issue #262).
--
-- Live-hit from run #9: every page a migration creates has
-- status='draft', and staging + production builds ship ONLY
-- status='published' pages. The skill never said so, so the migrated
-- site could not appear on staging at all — the operator hand-clicked
-- 92 per-row publish buttons, and the first Stage "succeeded" with a
-- zero-page build. The fix pairs with code changes in the same PR (the
-- static-generator now fails a full non-dev build with 0 published
-- pages, pointing at `set_pages_status_many`).
--
-- Publishing here is page STATUS only — it gates what the next staging
-- build includes. Nothing reaches production until the human clicks
-- Publish live / Confirm publish, so bulk-flipping migrated pages to
-- published is routine (revertible with one call) per CLAUDE.md §11.A.
--
-- Guarded + idempotent like 0130-0134: the UPDATE appends once and
-- no-ops when its marker text is already present.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = body || '

PUBLISH BEFORE STAGING: pages created by this migration are drafts, and staging + production builds ship ONLY status=''published'' pages — an all-draft migration produces an empty staging build where every URL 404s. Before the operator previews on staging, and before reporting the migration done, flip the migrated pages to published in bulk with `set_pages_status_many` (batches of up to 200 pageIds) — never one page at a time, and never ask the operator to click through pages. This changes page STATUS only: nothing reaches production until the operator explicitly publishes live, so do it without asking. Then tell the operator to click Stage in /edit to rebuild the staging preview. If a Stage or deploy fails with "0 published pages", that is exactly this state — bulk-publish first, then have the operator re-stage.'
WHERE slug = 'site-migrate'
  AND body NOT LIKE '%PUBLISH BEFORE STAGING%';

COMMIT;
