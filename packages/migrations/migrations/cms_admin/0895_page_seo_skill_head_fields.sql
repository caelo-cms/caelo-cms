-- SPDX-License-Identifier: MPL-2.0
--
-- 0895 — #1752: skill guidance for the SEO head fields.
--
-- The page-seo skill learns what 0894 added: every head value has an
-- origin the AI reads before it writes (the operator's own text is never
-- rewritten unasked), the `<title>` of most pages comes from a title
-- template per page type or site-wide (set_page_type_seo_many), og:type
-- per page type, and the robots directives besides noindex.
--
-- Surgical replace guarded by the exact old text: an operator-edited body
-- is left alone, and a second run changes nothing.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     'SEO is structured fields only — never raw HTML into the page <head>.',
     '- Read before you write: get_page_seo gives every head value with its origin. `human` is the operator''s own text — never rewrite it unasked. `ai` / `reviewed` are AI texts; `page_type` / `site` come from a title template; `inherited` is shared from another field of the page (og:title from the SEO title or page title, og:description from the meta description). Fill only real gaps: a template or inherited value is none.
- Titles: most pages need no own SEO title. The page type''s title template (else the site''s) renders `<title>`; set one pattern for all pages of a type with set_page_type_seo_many (e.g. `{page_title} | {site_name}`). Give a page its own seoTitle only when the template result does not fit it.
- Page types of dated posts (blog, news, press) get ogType `article` with set_page_type_seo_many: their pages then carry article:published_time / article:modified_time.
- Robots: max-image-preview `large` is stored by default. nosnippet, maxSnippet and nosnippetPlacements (data-nosnippet on a section) keep text out of snippets and AI answers in search; noarchive keeps cached copies (and Bing Copilot) away. Set them only when the operator asks.

SEO is structured fields only — never raw HTML into the page <head>.'
   )
 WHERE slug = 'page-seo'
   AND body LIKE '%SEO is structured fields only — never raw HTML into the page <head>.%'
   AND body NOT LIKE '%set_page_type_seo_many%';

COMMIT;
