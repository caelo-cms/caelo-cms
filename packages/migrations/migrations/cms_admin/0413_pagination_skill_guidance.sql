-- SPDX-License-Identifier: MPL-2.0
--
-- 0413 — #1257: skill guidance for paginated overviews (docs/lists.md §6
-- "Pagination").
--
-- A page query or the term_pages source shows at most 50 pages. An
-- overview (a guides hub, a category landing page) that must list every
-- matching page now paginates its list field: page 1 at the page's own
-- URL, follow-up pages at <path>/page/<n>/, and a pager the module draws
-- from the `pagination` system source. The manage-page-types skill
-- teaches category landing pages and page queries, so it gains the rule:
-- an overview paginates, a teaser keeps its limit.
--
-- Surgical: appended after the exact item-7 passage of 0356, guarded on
-- its own marker, so an operator-edited body is left alone and the
-- migration is idempotent.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     'Set the category entry''s `landing_page` link to that page so category links lead there.',
     'Set the category entry''s `landing_page` link to that page so category links lead there.

8. OVERVIEWS LIST EVERY PAGE. A query or term_pages shows at most 50 pages; an overview of all guides, products or a category''s pages must not stop there. Give its list field `paginate` (no `limit` in the query): `{name:"guides", kind:"list", label:"Guides", listType:"links", bind:"source", source:{kind:"query", editable:[], defaults:{page_type:"guide", order:"title_asc"}}, paginate:{}}`. Page 1 stays at the page''s URL; pages 2… are generated at `<path>/page/2/`, self-canonical and indexable. `paginate.per_page` (1–50, default 50) and `paginate.follow_ups:"noindex"` (follow-up pages out of search and the sitemap) are set only when the operator asks; a placement value `{paginate:{…}}` overrides them for one page. One paginated field per page. The page must show a pager, or Stage refuses it — best in the same module, as a second list field `{name:"pager", kind:"list", label:"Pages", listType:"links", bind:"source", source:{kind:"system", name:"pagination"}}` iterated as `<nav>{{#pager}}{{#is_prev}}<a rel="prev" href="{{link}}">←</a>{{/is_prev}}{{/pager}}{{#pager}}{{#is_current}}<span aria-current="page">{{number}}</span>{{/is_current}}{{^is_current}}<a href="{{link}}">{{number}}</a>{{/is_current}}{{/pager}}{{#pager}}{{#is_next}}<a rel="next" href="{{link}}">→</a>{{/is_next}}{{/pager}}</nav>` (empty while everything fits on one page). A teaser ("latest 3 news") keeps its `limit` and no pager. `preview_list_source` says "shows 50 of 63" for a cut list, and the Stage result names lists cut at 50 — paginate those.'
   )
 WHERE slug = 'manage-page-types'
   AND body LIKE '%Set the category entry''s `landing_page` link to that page so category links lead there.%'
   AND body NOT LIKE '%8. OVERVIEWS LIST EVERY PAGE.%';

COMMIT;
