-- SPDX-License-Identifier: MPL-2.0
--
-- 0445 — #1276: every page has a chosen page type; skill guidance follows.
--
-- `create_template` now takes `pageType` (an existing type) OR `newPageType`
-- (a new type created with the template as its default, in the same
-- call); a template without either is refused, and there is no default
-- page type any more. The skills that taught "template first, then the
-- type listing it" (0356) are corrected, so no skill points the AI at an
-- order that now fails (#1177):
--
--   * manage-page-types — steps 3 and 4: a new kind of content is ONE
--     create_template call with newPageType; upsert_page_types_many stays
--     for a type that reuses an existing template, and the duplicate
--     guard (`distinctFrom`) is named.
--   * templates-layouts — the 0356 sentence names newPageType.
--
-- Mechanics: replace() of exact passages (later migrations append to these
-- bodies, so a full restate would drop them). A replace() whose passage is
-- absent is a no-op, so the migration is idempotent.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(replace(
  body,
  $old$3. THE TEMPLATE. A page type lists the templates its pages may use. Reuse a fitting template (list_templates shows each template's page types), or create one with `create_template` — pass `pageType` to add it to an EXISTING type.$old$,
  $new$3. THE TEMPLATE. A page type lists the templates its pages may use, at least one. Reuse a fitting template (list_templates shows each template's page types). A NEW kind of content with its own template is ONE call: `create_template({slug, displayName, html, newPageType:{slug:"news", name:"News article", purpose:"…", properties:[…], vocabularies:[…]}})` creates the template and the type, with the template as its default. `pageType` instead adds the template to an EXISTING type. A template always names one of the two.$new$),
  $old$4. CREATE THE TYPE with `upsert_page_types_many($old$,
  $new$4. A TYPE ON AN EXISTING TEMPLATE (or changing a type) is `upsert_page_types_many`. A new slug that reads like an existing type (`blogs` next to `blog`, `news-article` next to `news`) is refused as the same kind of content — use the existing type, or pass `distinctFrom:["blog"]` when it really is different. Example: `upsert_page_types_many($new$)
WHERE slug = 'manage-page-types';

UPDATE skills
SET body = replace(
  body,
  $old$A template serves page types: pass `pageType` to add it to an existing type (list_page_types); a new kind of content is a new page type (manage-page-types skill).$old$,
  $new$A template serves page types: pass `pageType` to add it to an existing type (list_page_types), or `newPageType` to create a new kind of content together with this template (manage-page-types skill). One of the two is required.$new$)
WHERE slug = 'templates-layouts';

COMMIT;
