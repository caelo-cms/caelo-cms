-- SPDX-License-Identifier: MPL-2.0
-- caelo:contract pages.page_type_confirmed is NOT NULL without a column default; the previous image inserts pages without it
--
-- 0443 — #1276: every page has a chosen page type.
--
-- Until now a page created with neither `pageType` nor a single-type
-- template landed on `site_defaults.default_page_type_id`, a type nobody
-- chose. The create paths now require the choice (pageType, or a template
-- that belongs to exactly one type); this migration records which existing
-- pages never got one:
--
--   1. `pages.page_type_confirmed` (NOT NULL, deliberately no column
--      default: an INSERT outside the ops — test seeds, import tooling —
--      must state it, so no write path can silently mark a type chosen).
--      Backfill: false only for pages whose `page_type_id` is today's
--      stored default type, true for every other page (their type came
--      from an explicit pageType or a template of one type).
--   2. Page snapshots get the same field, computed the same way from the
--      snapshot's own `pageTypeId` (as 0351 step 3 did for the type), so a
--      merge or revert of an older snapshot replays a complete state and
--      readers need no default. A snapshot without `pageTypeId` keeps its
--      shape: 0351 already left it refused on revert.
--
-- The write-time trigger of 0351 (out-of-op INSERTs without page_type_id
-- get the ONE page type that lists their template) stays: it derives from
-- a template of exactly one type and never consulted the stored default.
--
-- The quality check `structure/unconfirmed-page-type` reports the pages
-- left at false on Stage; one update_pages_many naming their pageType
-- confirms them.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE pages ADD COLUMN page_type_confirmed boolean;

UPDATE pages p
   SET page_type_confirmed = NOT EXISTS (
         SELECT 1 FROM site_defaults sd
          WHERE sd.id = 1 AND sd.default_page_type_id = p.page_type_id
       );

ALTER TABLE pages ALTER COLUMN page_type_confirmed SET NOT NULL;

UPDATE page_snapshots ps
   SET state = ps.state || jsonb_build_object(
         'pageTypeConfirmed',
         NOT EXISTS (
           SELECT 1 FROM site_defaults sd
            WHERE sd.id = 1 AND sd.default_page_type_id::text = ps.state->>'pageTypeId'
         )
       )
 WHERE ps.state ? 'pageTypeId' AND NOT ps.state ? 'pageTypeConfirmed';

COMMIT;
