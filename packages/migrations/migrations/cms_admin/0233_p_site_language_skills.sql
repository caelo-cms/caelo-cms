-- SPDX-License-Identifier: MPL-2.0
--
-- 0233 — the site language is captured with the site identity.
--
-- 0232 removed the `en` default from site_defaults.site_language: until it
-- is set, publishing fails. The two flows that capture identity on a new
-- site — Site Genesis (BRIEF step) and Site Migration (UNDERSTAND step) —
-- now pass `siteLanguage` in the same `set_site_identity` call, inferred
-- from the operator's own words (Genesis) or the source site's `<html
-- lang>` as inspect_external_page reports it (`Lang:`, Migration).
--
-- Each UPDATE is a targeted `replace()` guarded by `body LIKE` on the
-- exact old sentence: idempotent, a no-op on an install whose skill text
-- has already moved on, and it never touches an Owner-edited body that no
-- longer carries the sentence.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     '2. BRIEF — write it: `set_site_identity({siteName, sitePurpose, designBrief: {audience, moodWords, tone, industry, differentiators, imageryDirection, avoid}})`.',
     '2. BRIEF — write it: `set_site_identity({siteName, sitePurpose, siteLanguage, designBrief: {audience, moodWords, tone, industry, differentiators, imageryDirection, avoid}})`. `siteLanguage` is the BCP 47 tag of the language the operator writes in or wants the site copy in (`en`, `de`, `pt-BR`); it has no default and publishing fails without it, so never leave it out.'
   )
 WHERE slug = 'site-genesis'
   AND body LIKE '%2. BRIEF — write it: `set_site_identity({siteName, sitePurpose, designBrief: {audience, moodWords, tone, industry, differentiators, imageryDirection, avoid}})`.%';

UPDATE skills
   SET body = replace(
     body,
     '   - `set_site_identity({siteName, sitePurpose})` from what the homepage reveals.',
     '   - `set_site_identity({siteName, sitePurpose, siteLanguage})` from what the homepage reveals — `siteLanguage` is the `Lang:` that inspect_external_page reports for the page you migrate (the primary language when you migrate one locale of a multilingual site); if the source page has none, use the language its content is written in. It has no default and publishing fails without it.'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%   - `set_site_identity({siteName, sitePurpose})` from what the homepage reveals.%';

COMMIT;
