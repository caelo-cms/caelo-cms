-- SPDX-License-Identifier: MPL-2.0
--
-- 0156 — site-migrate: steer the build phase to ONE `build_page` call per
-- page (issue #299, epic #252 follow-up).
--
-- Run #15 telemetry (run-logs/run15-analysis.md): the #278 flow assembled
-- ~14 pages through ~100 singular round-trips — 36× add_module_to_page,
-- 29× set_page_module_content, 9× create_content_instance, 8× create_page —
-- each a full API call at 110K–556K input tokens. CLAUDE.md §11 mandates
-- bulk-first; issue #299 ships `build_page` (page + modules + content +
-- placements in one transaction) plus `create_content_instances` and
-- `set_page_module_content_many` for incremental passes. The skill body
-- still describes the build phase in singular-call terms, so the model
-- keeps walking the expensive chain; this puts the batching rule INSIDE
-- THE REBUILD CONTRACT, which also rides verbatim into every subagent
-- brief (0150 STEP 4), so fan-out workers inherit it too.
--
-- Targeted, idempotent amendment (same REPLACE-with-guard pattern as
-- 0151/0154): REPLACE the contract's "REPLACE IN ONE STEP" bullet with the
-- same bullet + a new ONE-CALL-PER-PAGE bullet. Guarded so a re-run is a
-- no-op and this only fires against the #278 body that still lacks the
-- build_page steering.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = REPLACE(
  body,
  '   - REPLACE IN ONE STEP: author the complete clean replacement, then swap it in. Never clear a page first and rebuild into the emptiness; a page must never be presented blank or with missing content.',
  '   - REPLACE IN ONE STEP: author the complete clean replacement, then swap it in. Never clear a page first and rebuild into the emptiness; a page must never be presented blank or with missing content.
   - ONE build_page CALL PER PAGE: assemble each page with a SINGLE `build_page` call — the page (new via {slug, title}, or existing via {pageId}) plus the FULL ordered module list, each module carrying its html/css/fields AND its content in the same entry (content.source=''inline'' with the page''s own values for page-local copy; content.source=''shared'' with a purpose for content reused across pages; content.source=''existing'' to bind an instance already in the library). NEVER build a page as a chain of create_page + add_module_to_page + set_page_module_content + create_content_instance calls — every link in that chain is a full round-trip that build_page collapses into one transaction. Later passes over EXISTING pages batch the same way: `set_page_module_content_many` for several placements at once, `create_content_instances` for several shared rows at once. The build phase of one page is 1–3 tool calls, not 10.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%FAIL-FAST, HOMEPAGE-FIRST (issue #278)%'
  AND body LIKE '%REPLACE IN ONE STEP: author the complete clean replacement%'
  AND body NOT LIKE '%ONE build_page CALL PER PAGE%';

COMMIT;
