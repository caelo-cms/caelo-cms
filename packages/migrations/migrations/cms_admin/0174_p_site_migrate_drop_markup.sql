-- SPDX-License-Identifier: MPL-2.0
--
-- 0174 — site-migrate: drop the removed `markup` facet from the guidance.
--
-- inspect_external_page no longer has a raw-`markup` facet (a single rich
-- one ran to ~380K tokens and overflowed the model's window in the full
-- e2e migrate run). Understanding a page is `markdown`; specific structure
-- is `query_page_html` (already added to Step-3 in 0172). The skill itself
-- says the legacy markup is "div soup NOT worth preserving" — so stop
-- asking for it. Surgical replace(), idempotent.

BEGIN;

-- Step-1 note: rich facets that "come later".
UPDATE skills SET body = replace(
  body,
  'The rich facets (markup, screenshot, tokens, altTexts) come later',
  'The rich facets (screenshot, tokens, altTexts) — plus query_page_html for any specific structure — come later'
) WHERE slug = 'site-migrate';

-- Step-3 rich inspect: drop markup from the facets call + "markup for structure".
UPDATE skills SET body = replace(
  body,
  'facets:{markup:true, screenshot:true, tokens:true, altTexts:true}})`: markup for structure, screenshot',
  'facets:{screenshot:true, tokens:true, altTexts:true}})`: screenshot'
) WHERE slug = 'site-migrate';

-- Logo line: altTexts alone gives the source logo <img> src.
UPDATE skills SET body = replace(
  body,
  'altTexts/markup facets already gave you',
  'altTexts facet already gave you'
) WHERE slug = 'site-migrate';

-- Per-type build: drop markup from the rich-inspect facet set.
UPDATE skills SET body = replace(
  body,
  'inspect its sample RICHLY (`inspect_external_page` with {markup, screenshot, tokens, altTexts})',
  'inspect its sample RICHLY (`inspect_external_page` with {screenshot, tokens, altTexts}; read the content as Markdown, and pull any specific structure with query_page_html)'
) WHERE slug = 'site-migrate';

COMMIT;
