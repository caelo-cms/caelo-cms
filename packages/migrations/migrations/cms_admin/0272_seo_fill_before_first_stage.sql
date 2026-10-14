-- SPDX-License-Identifier: MPL-2.0
--
-- 0272 — SEO fill-once before the first Stage (CLAUDE.md §2).
--
-- On searchviu.com migrated pages went live with EMPTY meta descriptions:
-- nothing in the page-building flows told the AI to write them. The
-- `page-seo` skill that does is engaged only on SEO keywords, and the
-- site-migrate and compose-page bodies went straight from "flip to
-- published" to Stage. The crawl even had the source pages' descriptions
-- and dropped them. Staging and production builds now refuse pages without
-- a meta description (admin-core deploy/missing-seo.ts); this migration
-- makes the flows write them before the Stage instead of running into it.
--
-- 1. import_pages.source_meta_description — the crawled page's own
--    description ('' = the source has none; NULL = crawled before this
--    migration). get_import_page surfaces it for the carry-over.
--
-- 2. Skill bodies, each a `replace()` guarded by `body LIKE` on the exact
--    old text plus a NOT LIKE on the new tool name: idempotent, a no-op on
--    an install whose text has moved on, and it never touches an
--    Owner-edited body that no longer carries the sentence (same pattern
--    as 0246).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_pages ADD COLUMN IF NOT EXISTS source_meta_description text NULL;

UPDATE skills
   SET body = replace(
     body,
     '   - Then Stage it yourself with `stage_changes` (staging preview + quality check;',
     E'   - Give every migrated page its first meta description with `autofill_page_seo_many` (one call, up to 200 pages): carry over the "Source meta description" `get_import_page` reports (shortened to at most 160 characters), and write one from the page''s content where the source had none. A Stage refuses published pages without a description and names them.\n   - Then Stage it yourself with `stage_changes` (staging preview + quality check;'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%   - Then Stage it yourself with `stage_changes` (staging preview + quality check;%'
   AND body NOT LIKE '%autofill_page_seo_many%';

UPDATE skills
   SET body = replace(
     body,
     '- Status: set_pages_status_many to publish / unpublish (draft to live).',
     '- Status: set_pages_status_many to publish / unpublish (draft to live). Before a new page''s first Stage, write its meta description from the page''s content with autofill_page_seo_many (one call for all new pages) — a Stage refuses published pages without one.'
   )
 WHERE slug = 'compose-page'
   AND body LIKE '%- Status: set_pages_status_many to publish / unpublish (draft to live).%'
   AND body NOT LIKE '%autofill_page_seo_many%';

-- page-seo claimed the tool "derives" the description from the page; it
-- does not — the AI writes it and the tool stores it once.
UPDATE skills
   SET body = replace(
     body,
     'It derives title / meta description / Open Graph from the page content. It fills ONCE',
     'Write the description from the page''s content (several pages: autofill_page_seo_many, one call); staging and production builds refuse published pages without one. It fills ONCE'
   )
 WHERE slug = 'page-seo'
   AND body LIKE '%It derives title / meta description / Open Graph from the page content. It fills ONCE%'
   AND body NOT LIKE '%autofill_page_seo_many%';

UPDATE skills
   SET allowlisted_tools = allowlisted_tools || '["autofill_page_seo_many"]'::jsonb
 WHERE slug IN ('page-seo', 'fix-quality-findings')
   AND jsonb_array_length(allowlisted_tools) > 0
   AND NOT allowlisted_tools @> '["autofill_page_seo_many"]'::jsonb;

COMMIT;
