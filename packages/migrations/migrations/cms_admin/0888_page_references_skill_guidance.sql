-- SPDX-License-Identifier: MPL-2.0
--
-- 0888 — skill guidance for page references and term overview pages
-- (issue #1754, epic #1751; docs/lists.md §2, §6).
--
-- An author is a normal page of a page type (maintainer decision
-- 2026-11-26): an article names its authors with a `page` property, in
-- order, and the author page lists the articles naming it with a page
-- query `refers_to: {property, page: "self"}`. A term never makes a page
-- by itself; an important topic gets a curated page, and the term's
-- `landing_page` (now on every vocabulary type, 0887) points there, so
-- term chips link it and breadcrumbs given the vocabulary lead through
-- it. The manage-page-types skill teaches page types, vocabularies and
-- page queries, so it gains both; manage-module names the new query
-- filter where it lists the sources.
--
-- Surgical: each change replaces an exact passage of the shipped body and
-- is guarded on its own marker, so an operator-edited body is left alone
-- and the migration is idempotent.

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     'Categories and tags are lists of the shipped vocabulary types `categories` (nested, with an optional landing page) and `tags`.',
     'Categories and tags are lists of the shipped vocabulary types `categories` (nested) and `tags`; every entry can name its overview page (`landing_page`, item 10).'
   )
 WHERE slug = 'manage-page-types'
   AND body LIKE '%(nested, with an optional landing page) and `tags`.%';

--> statement-breakpoint

UPDATE skills
   SET body = replace(
     body,
     'Properties use the list field types (text, richtext, link, media, select, boolean, number, date, icon, term).',
     'Properties use the list field types (text, richtext, link, media, select, boolean, number, date, icon, term, page).'
   )
 WHERE slug = 'manage-page-types'
   AND body LIKE '%Properties use the list field types (text, richtext, link, media, select, boolean, number, date, icon, term).%';

--> statement-breakpoint

UPDATE skills
   SET body = replace(
     body,
     'OVERVIEW PAGES ARE QUERIES.',
     '9. PAGES THAT NAME PAGES. An author, reviewer, speaker, venue or manufacturer is a normal page of its own page type (`author`, `venue` …), never text in a property. The page that names it carries a `page` property: `{name:"authors", label:"Authors", type:"page", pageType:"author", multiple:true}` (one page: no `multiple`, e.g. `reviewed_by`). Set it with page paths in order (`update_pages_many` / `build_page` `properties:{authors:["/team/anna", "/team/ben"]}`); the references follow renames and moves. A template shows them with `{{#page.props.authors}}<a href="{{link}}">{{title}}</a>{{/page.props.authors}}` (each a page: title, link, image, props.<name>). The named page lists the pages naming it with ONE query field: `source:{kind:"query", editable:[], defaults:{page_type:"article", refers_to:{property:"authors", page:"self"}, order:"published_desc"}}` with `paginate:{}` and a pager (item 8) — an author page lists ALL their articles. It rebuilds by itself when an article starts or stops naming the author.

10. TOPIC PAGES. A term never makes a page by itself. An important topic gets a real page (`build_page`, with a `term_pages` or query list of its pages, item 7); set the term entry''s `landing_page` link to it (`patch_list_items_many`) — every vocabulary (categories, tags, your own) has that field. Term chips `{{#page.terms.<vocabulary slug>}}<a href="{{link}}">{{name}}</a>{{/page.terms.<vocabulary slug>}}` then link there, and a breadcrumbs field given the vocabulary (`list:"caelo:list/<vocabulary id>"` next to `source:{kind:"system", name:"breadcrumbs"}`) leads Home → … → topic page → article. A term without a topic page links nowhere (`{{link}}` is empty): wrap the chip''s link in `{{#link}}…{{/link}}`.

OVERVIEW PAGES ARE QUERIES.'
   )
 WHERE slug = 'manage-page-types'
   AND body LIKE '%OVERVIEW PAGES ARE QUERIES.%'
   AND body NOT LIKE '%9. PAGES THAT NAME PAGES.%';

--> statement-breakpoint

UPDATE skills
   SET body = replace(
     body,
     'a page query (`{kind:"query", …}`: latest news, related articles)',
     'a page query (`{kind:"query", …}`: latest news, related articles, an author''s articles with `refers_to:{property:"authors", page:"self"}`)'
   )
 WHERE slug = 'manage-module'
   AND body LIKE '%a page query (`{kind:"query", …}`: latest news, related articles)%';
