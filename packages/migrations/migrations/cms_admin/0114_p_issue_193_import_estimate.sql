-- SPDX-License-Identifier: MPL-2.0
--
-- 0114 — crawl-scope estimate on import proposals (issue #193,
-- epic #186). §11.A: the preview must be a blast-radius summary; for
-- a migration the page count IS the blast radius. The jsonb carries
-- either {pages, basis, crawlMinutes, aiCostUsd:{low,high}} or a loud
-- {failed, reason} — an unknown scope is shown as unknown, never
-- silently omitted.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_runs ADD COLUMN estimate jsonb NULL;

COMMIT;
