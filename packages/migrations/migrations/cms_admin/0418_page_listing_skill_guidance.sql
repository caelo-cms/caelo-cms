-- SPDX-License-Identifier: MPL-2.0
--
-- 0418 — issue #1256: an overview of pages is a page query, never cards.
--
-- The core `structure/manual-page-listing` quality check now blocks an
-- overview page (a guides hub, a category page) kept as one hand-written
-- card per page, and the write tools hint at it. The page-building
-- guidance says the same up front, so the AI builds the listing right the
-- first time:
--
--   * manage-page-types — its "showing typed pages" step gains the rule.
--   * compose-page — the page-building skill, where hubs get built.
--
-- Each paragraph is appended once, guarded on its own marker, so the
-- migration is idempotent.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = body || $overview$

OVERVIEW PAGES ARE QUERIES. A page that lists pages — a guides hub, a news overview, a category page, a product index — is ONE `list` field bound to a source: a page query (`bind:"source", source:{kind:"query", defaults:{page_type:"<slug>"}}`), `term_pages` for a category, `children` for a section's sub-pages. Never one hand-written card (a card module in a module-list, a local list entry, numbered link fields) per page: the next page of the type is then missing until someone adds it by hand. The structure quality check blocks such a listing while pages of the type are missing (structure/manual-page-listing). A deliberate pick of a few pages ("our top 3 guides") stays a hand-kept list.$overview$
WHERE slug IN ('manage-page-types', 'compose-page')
  AND body NOT LIKE '%OVERVIEW PAGES ARE QUERIES%';

COMMIT;
