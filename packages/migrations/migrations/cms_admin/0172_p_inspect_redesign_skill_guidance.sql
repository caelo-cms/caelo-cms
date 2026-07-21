-- SPDX-License-Identifier: MPL-2.0
--
-- 0172 — wire the external-page inspection redesign
-- (docs/inspect-tooling-redesign.md) into the two skills that drive it:
-- site-migrate (whole-site) and import-page (single page). onboarding
-- routes to site-migrate, so it is covered too.
--
-- Step-1 "understand a page" now uses the GIST (meta + the page text as
-- Markdown, far smaller than raw markup); `links` is enabled only on the
-- first/homepage inspect (index/nav pages carry 200+ links); long pages
-- page via read_page_more; a single section comes from query_page_html
-- (keyword or a natural-language `describe` that a small model extracts)
-- instead of dumping the whole HTML into the chat.
--
-- Surgical string replacements (not a full-body rewrite) so unrelated
-- guidance stays byte-identical; replace() is idempotent (a second run
-- finds nothing to change). Matches the CURRENT DB body (post-0150/0169).

BEGIN;

-- site-migrate: homepage inspect → gist (meta + markdown) + links (homepage only).
UPDATE skills SET body = replace(
  body,
  '`inspect_external_page({url, facets:{links:true, meta:true}})` on the homepage — links + meta ONLY (the cheap facets). Keep this turn small; the rich facets (markup, screenshot, tokens, altTexts) come later, only when you build from a sample.',
  '`inspect_external_page({url, facets:{markdown:true, meta:true, links:true}})` on the homepage — the GIST (meta + the page text as Markdown) PLUS the nav/footer link map. Enable `links` ONLY on this first/homepage inspect (later content inspects skip it — index/nav pages carry 200+ links that bloat the turn). For a long page, page the Markdown with `read_page_more({pageRef, cursor})`. The rich facets (markup, screenshot, tokens, altTexts) come later, only when you build from a sample.'
)
WHERE slug = 'site-migrate';

-- site-migrate: pull ONE section with query_page_html instead of whole markup.
UPDATE skills SET body = replace(
  body,
  'altTexts for the image inventory.',
  'altTexts for the image inventory. When you need just ONE section of a big page (a pricing table, a specific block) rather than the whole markup, use `query_page_html({pageRef, describe:"the pricing table"})` (natural language — a small model extracts it) or `query_page_html({pageRef, keyword:"..."})`.'
)
WHERE slug = 'site-migrate';

-- import-page: gist-first look + read_page_more + query_page_html.
UPDATE skills SET body = replace(
  body,
  '1. Look first: inspect_external_page (and screenshot_external_page) fetch the target URL so you can see its structure and design before committing.',
  '1. Look first: `inspect_external_page({url})` returns the GIST (meta + the page text as Markdown) so you understand the page cheaply, and `screenshot_external_page({url})` gives the visual. Page a long page with `read_page_more({pageRef, cursor})`, and pull a specific section with `query_page_html({pageRef, describe:"..."})` — never load the whole raw HTML into the chat.'
)
WHERE slug = 'import-page';

-- import-page: preload the new inspection tools (allowlist = preload hints).
UPDATE skills SET allowlisted_tools =
  '["inspect_external_page","read_page_more","query_page_html","screenshot_external_page","propose_site_import","compose_from_import","map_external_page_types","find_media","build_page"]'::jsonb
WHERE slug = 'import-page';

COMMIT;
