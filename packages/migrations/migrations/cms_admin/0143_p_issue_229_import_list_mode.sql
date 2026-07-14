-- SPDX-License-Identifier: MPL-2.0
--
-- 0143 — list-mode site import (issue #229, prerequisite for the #278
-- migration flow).
--
-- The pilot crawl used to be a blind depth-N BFS: it grabbed whatever
-- the link graph exposed (in the live searchviu run that meant 1 product
-- page + 19 blog posts instead of "one of each page type"). The new flow
-- (#278) instead has the AI inspect the homepage, pick exactly the URLs
-- that cover the distinct page types, and crawl EXACTLY that list.
--
-- `explicit_urls` stores that chosen set as a jsonb array of absolute URL
-- strings. NULL = the classic depth/BFS mode (the two are mutually
-- exclusive at the propose boundary). When set, the crawler fetches only
-- these URLs (+ the source origin for scoping), no BFS, no depth expansion
-- — every URL still passes the same-origin + robots + hardened-fetch
-- gates and the same per-page extraction/screenshot pipeline.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS explicit_urls jsonb NULL;

COMMIT;
