-- SPDX-License-Identifier: MPL-2.0
--
-- 0356 — epic #1107 part E (#1112): skill guidance for lists, list types
-- and page types (docs/lists.md).
--
-- Structured sets, the `text-list` / `link-list` field kinds, the
-- `nav-menu-<slug>` module binding and `templates.kind` are gone (0350–
-- 0354). Every seeded skill that still taught them is corrected here, so
-- no skill points the AI at a tool or a syntax that no longer exists:
--
--   * manage-menu — full-body rewrite (0170 / 0207 precedent: the old body
--     is wrong from its first line, a surgical replace would leave none of
--     it). Menus, navigation and footer links are SHARED lists of a fitting
--     list type, maintained item by item with patch_list_items_many and
--     bound by the header / footer module's `list` field; mega menus are a
--     list type with column nodes and a news query node.
--   * manage-page-types — NEW skill: a new content format is a page type
--     with properties and vocabularies (categories / tags lists); category
--     landing pages are ordinary pages with a `term_pages` source module.
--   * manage-module, compose-page — the list-field guidance (0168 items
--     3–5, 0207's module-list note, 0208's #417 subsection) now teaches the
--     `list` kind and the local-vs-shared rule; compose-page, site-genesis
--     and site-migrate set `pageType` on build_page.
--   * templates-layouts — create_template takes the page type.
--   * fix-quality-findings — a broken menu link lives in a list entry.
--   * menu-auditor, qa-check — allowlists named the deleted structured-set
--     tools; menu-auditor's body read the sets.
--   * bootstrap-site, compose-page — `create_page` (removed long ago; build_page
--     is the single page-creation tool) leaves their preload hints.
--
-- Mechanics: full restates where the whole body is obsolete (manage-menu,
-- menu-auditor); replace() of exact passages elsewhere, because later
-- migrations append to those bodies and a full restate would drop them. A
-- replace() whose passage is absent is a no-op, and every appended
-- paragraph is guarded on its own marker, so the migration is idempotent.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

------------------------------------------------------------------------
-- 1) manage-menu — menus are shared lists.
------------------------------------------------------------------------
UPDATE skills
SET description = 'Build and edit site navigation — header menus, mega menus, footer links and other link groups, all kept as shared lists. Engaged when the user asks to add, remove, rename or reorder navigation links.',
    body = $manage_menu_v4$You are building or editing site navigation — header menus, mega menus, footer links and other link groups.

A menu, the navigation, the footer links, categories and tags are all SHARED LISTS of a fitting list type — never links hardcoded into module HTML and never numbered module fields. A list is a tree of entries; its list type says which entry kinds (nodes) exist, which fields each has and what may hang under what. There are no menu-specific tools: the list tools are the menu tools.

1. READ FIRST. `list_lists({role: "navigation"})` shows the site's menus with their purpose and where they are used (modules, placements, sample pages). Pick the list the operator means from that usage — "the menu" is the list the header module binds, "the footer links" the one the footer module binds. `get_list({slug})` returns the entries with their ids. Never re-invent a menu that exists.

2. SMALL CHANGES ARE PATCHES. Change entries with `patch_list_items_many` — add / update / move / remove by entry id, without resending the tree. "Add Careers under Company" is ONE patch: `patch_list_items_many({lists:[{slug:"main-menu", patches:[{op:"add", parentId:"<id of Company>", item:{node:"entry", values:{label:"Careers", link:{href:"/careers"}}}}]}]})`. Rename = `{op:"update", itemId, values:{label}}`; reorder = `{op:"move", itemId, parentId?, position}`. Several menus in one call when the change spans them. Use `upsert_lists_many` only to create a list or to replace a whole tree.

3. LINKS POINT AT REAL PAGES. A link value is `{href, target?}`; write internal links as the page's path (`/about`, `/about#team`) — Caelo stores them as page references, so they follow renames and moves on their own. A page that does not exist yet is refused: build it first (build_page), then link it. Do not stall asking which page to point at.

4. PICK THE LIST TYPE. `list_list_types()` lists the types; the shipped ones are `menu` (entries with label + link, nested up to three levels — header navigation with dropdowns), `links` (a flat link group — footer links, legal links, social links), `texts`, `categories`, `tags`. Reuse a type that fits. Create a new one with `upsert_list_types_many` only when the shape is genuinely different.

5. MEGA MENUS are a list type of their own, e.g.:
   `{slug:"mega-menu", name:"Mega menu", purpose:"Header navigation whose top entries open panels of link columns and the latest news.", role:"navigation", root:{allow:["entry"]}, nodes:{
     entry:{label:"Top entry", fields:[{name:"label",label:"Label",type:"text",required:true},{name:"link",label:"Link",type:"link"}], children:{name:"columns", allow:["column","news"], max:4}, current_from:"link"},
     column:{label:"Column", fields:[{name:"heading",label:"Heading",type:"text",required:true}], children:{name:"links", allow:["link"]}},
     link:{label:"Link", fields:[{name:"label",label:"Label",type:"text",required:true},{name:"link",label:"Link",type:"link",required:true}], current_from:"link"},
     news:{label:"Latest news", fields:[{name:"heading",label:"Heading",type:"text",required:true}], source:{kind:"query", editable:["limit","terms"], defaults:{page_type:"news", order:"published_desc", limit:3}}}}}`
   A `news` entry has no stored children: its `items` are the newest published pages of the `news` page type, generated per build (the page type must exist — see the manage-page-types skill). Check what a query returns with `preview_list_source`. A footer with link columns is the same idea: a list of `column` entries holding `link` entries, or a `links` list per column when the columns are independent.

6. BIND THE MODULE. The header / footer module carries ONE `list` field bound to the shared list: `{name:"menu", kind:"list", label:"Menu", listType:"mega-menu", bind:"shared", list:"caelo:list/<id>"}` (the id from upsert_lists_many / list_lists). Its HTML iterates the entries with mustache sections, e.g. `<nav>{{#menu}}<a href="{{link}}"{{#is_current}} aria-current="page"{{/is_current}}>{{label}}</a>{{#has_columns}}<div class="panel">{{#columns}}{{#is_column}}<div><h3>{{heading}}</h3>{{#links}}<a href="{{link}}">{{label}}</a>{{/links}}</div>{{/is_column}}{{#is_news}}<div><h3>{{heading}}</h3>{{#items}}<a href="{{link}}">{{title}}</a>{{/items}}</div>{{/is_news}}{{/columns}}</div>{{/has_columns}}{{/menu}}</nav>`. Inside a section the entry's own keys render (`{{label}}`, `{{link}}`, `{{#children}}…{{/children}}`, `{{>recurse}}` for a tree of any depth). For a collapsing mobile menu use the interaction kit's `mobile-nav` markup. Place the module ONCE on the layout — `add_module(target = "layout", blockName = "header" | "footer")` — and it shows on every page bound to that layout (usually the whole site; check list_layouts when there are several). Never loop per page, never build_page for chrome.

7. LOCAL OR SHARED. A list only one module uses, flat, edited together with that module (three feature bullets, the social icons in one hero) stays LOCAL: the entries live in the module field's value (`bind: "local"`, the default). Navigation of the site, anything shown in more than one place, anything people edit without touching the module, and vocabularies pages are tagged with are SHARED. When a local list turns out to be needed elsewhere ("show the footer links in the mobile menu too"), `promote_local_list({moduleId, field, slug, name, purpose})` makes it a shared list and rebinds the field in one call.

Keep labels short and consistent; match the site's existing capitalisation and voice.$manage_menu_v4$,
    allowlisted_tools = '["list_lists","get_list","list_list_types","upsert_list_types_many","upsert_lists_many","patch_list_items_many","promote_local_list","preview_list_source","add_module","edit_module","list_modules","list_layouts","list_pages","build_page"]'::jsonb,
    auto_engagement_hints = '{"keywords":["menu","navigation","navbar","nav menu","header menu","footer menu","mega menu","dropdown","footer links","nav link","menu item","add to the menu","reorder the menu","navigation links"],"chipTrigger":false,"alwaysOn":false}'::jsonb
WHERE slug = 'manage-menu';

------------------------------------------------------------------------
-- 2) manage-page-types — new skill.
------------------------------------------------------------------------
INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES
  (
    'manage-page-types',
    'Page types, categories & tags',
    'Set up a new kind of content — news, blog articles, products, events — as a page type with its own properties, categories and tags, and assign pages to it. Engaged when the user asks for a new section or content format, for categories or tags, or to sort pages into them.',
    $manage_page_types_v1$You are setting up or changing what KIND of pages the site has: a page type (news, blog article, product, event, job opening …), its properties, and the categories and tags pages are sorted into.

Every page has a page type. The type says which templates its pages may use, which properties they carry (date, author, price …) and which vocabularies they are tagged with. Page queries (a "latest news" block, a related-articles list, a category landing page) filter on exactly these. The operator never says "page type": "I need a news section with categories" means a `news` page type with a `categories` vocabulary.

1. READ FIRST. `list_page_types()` shows the types with their purpose, templates, properties, vocabularies and page count; `list_page_types({slug})` adds sample pages. Reuse a type that fits — a second "article" type next to an existing "blog-post" splits the site's content.

2. VOCABULARIES ARE SHARED LISTS. Categories and tags are lists of the shipped vocabulary types `categories` (nested, with an optional landing page) and `tags`. Create them with `upsert_lists_many({lists:[{slug:"news-categories", name:"News categories", purpose:"Topics news articles are filed under", type:"categories", items:[{node:"category", values:{name:"Product", slug:"product"}}, …]}]})`. Each entry's id makes its term: `caelo:term/<listId>/<entryId>` (ids from upsert_lists_many / get_list). Add a category later with `patch_list_items_many`.

3. THE TEMPLATE. A page type lists the templates its pages may use. Reuse a fitting template (list_templates shows each template's page types), or create one with `create_template` — pass `pageType` to add it to an EXISTING type.

4. CREATE THE TYPE with `upsert_page_types_many({pageTypes:[{slug:"news", name:"News article", purpose:"Dated company news; listed newest first on the news overview and in the header's latest-news panel", templates:["<template id>"], defaultTemplate:"<template id>", properties:[{name:"author", label:"Author", type:"text"}, {name:"event_date", label:"Event date", type:"date"}], vocabularies:[{list:"<news-categories list id>", cardinality:"many"}]}]})`. Properties use the list field types (text, richtext, link, media, select, boolean, number, date, icon, term). A new required property needs a `default` for the pages the type already has.

5. ASSIGN PAGES. New pages: `build_page({page:{slug, title, pageType:"news", properties:{author:"…"}, terms:["caelo:term/<listId>/<entryId>"]}, modules:[…]})`. Existing pages: ONE `update_pages_many` call with `pageType`, `properties` (merged; null removes one) and `terms` (replaces) per page — the template must be one of the type's templates (pass `templateId` too when it is not).

6. SHOWING TYPED PAGES. A module lists pages through a `list` field with a source: `{name:"latest", kind:"list", label:"Latest news", listType:"links", bind:"source", source:{kind:"query", editable:["limit","terms"], defaults:{page_type:"news", order:"published_desc", limit:3}}}`, iterated as `{{#latest}}<a href="{{link}}">{{title}}</a> {{published_at}}{{/latest}}` (each entry: title, link, published_at, summary, image, props.<name>, terms.<vocabulary>). Check what a query returns with `preview_list_source` before you build on it. A page shows its own categories with a `page_terms` system source.

7. CATEGORY LANDING PAGES are ordinary pages (build_page) carrying a module whose `list` field has `bind:"source", source:{kind:"system", name:"term_pages"}`; the placement's value names the term(s) (`{terms:["caelo:term/<listId>/<entryId>"]}`) and the field lists the published pages tagged with them. Set the category entry's `landing_page` link to that page so category links lead there.

8. CHANGING A TYPE that has pages is checked against every page: removing a property or vocabulary that pages still use is refused, naming the pages, unless you resend with `dropValues: true` after the operator agreed. `delete_page_types_many` is refused while pages use the type — move them first.$manage_page_types_v1$,
    '["list_page_types","upsert_page_types_many","delete_page_types_many","list_list_types","list_lists","get_list","upsert_lists_many","patch_list_items_many","preview_list_source","create_template","list_templates","update_pages_many","list_pages","build_page","add_module"]'::jsonb,
    '{"keywords":["page type","content type","new section","news section","blog","articles","categories","category","tags","tag","taxonomy","assign to category","landing page for","properties"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  )
ON CONFLICT (slug) DO NOTHING;

------------------------------------------------------------------------
-- 3) manage-module — the `list` field kind.
------------------------------------------------------------------------
UPDATE skills
SET body = replace(replace(replace(replace(
  body,
  $old$REPEATING content is ONE list field (`text-list`, `link-list`, or a `module-list` of sub-modules) holding N items — never numbered scalars (`item`, `item2`, `item3`).$old$,
  $new$REPEATING content is ONE `list` field (entries of a list type: `texts` for plain strings, `links` for label + link, `menu` for a nested menu, or another type from list_list_types) or a `module-list` of sub-modules — never numbered scalars (`item`, `item2`, `item3`).$new$),
  $old$A text-list iterates as `{{#features}}<li>{{.}}</li>{{/features}}` (`{{.}}` is the current string item). A link-list iterates as `{{#links}}<a href="{{href}}">{{label}}</a>{{/links}}` (`{{href}}` / `{{label}}` are the per-item keys). The section name and its enclosing field are the ONLY declared fields; `{{.}}` / `{{href}}` / `{{label}}` inside a section are per-item locals, not separate fields.$old$,
  $new$Inside `{{#field}}…{{/field}}` the keys are the entry's fields: a `texts` list iterates as `{{#features}}<li>{{text}}</li>{{/features}}`, a `links` list as `{{#links}}<a href="{{link}}">{{label}}</a>{{/links}}`, a `menu` entry's sub-entries with `{{#children}}…{{/children}}` (or `{{>recurse}}` for a tree of any depth); `{{#is_current}}` marks the entry linking the current page. The section name is the ONLY declared field; `{{text}}` / `{{label}}` / `{{link}}` inside a section are entry keys, not separate fields.$new$),
  $old$model repeated chrome content as a `link-list`/`text-list` field with a `default` instead.$old$,
  $new$model repeated chrome content as a `list` field instead — a shared list (`bind: "shared"`) for navigation, or a local one with a `default`.$new$),
  $old$A link-list default is an array of `{label, href}`; a text-list default is an array of strings.$old$,
  $new$A local list default is an array of entries with the real text and links: `[{"node":"link","values":{"label":"Home","link":{"href":"/"}}}]` for `links`, `[{"node":"text","values":{"text":"Fast"}}]` for `texts`.$new$)
WHERE slug = 'manage-module';

UPDATE skills
SET body = body || $local_shared$

LIST FIELDS — LOCAL OR SHARED:
- LOCAL (`bind: "local"`, the default): the entries are stored with the placement — a list only this module uses, flat, edited together with the module (feature bullets, one hero's social icons).
- SHARED (`bind: "shared"`, `list: "caelo:list/<id>"`): the module shows a list that lives on its own — site navigation, footer links, anything shown in more than one place or edited without touching the module, and vocabularies (categories, tags). Create it with upsert_lists_many; the manage-menu skill covers menus.
- SOURCE (`bind: "source"`): entries generated per page — a page query (`{kind:"query", …}`: latest news, related articles) or a system source (breadcrumbs, children, siblings, page_terms, term_pages). Check one with preview_list_source.
- A local list that turns out to be needed elsewhere becomes shared with ONE promote_local_list call (it creates the list and rebinds the field).$local_shared$
WHERE slug = 'manage-module'
  AND body NOT LIKE '%LIST FIELDS — LOCAL OR SHARED%';

------------------------------------------------------------------------
-- 4) The #417 subsection (manage-module + compose-page) and compose-page.
------------------------------------------------------------------------
UPDATE skills
SET body = replace(replace(replace(
  body,
  $old$Repeating content is ONE list field holding N items: `text-list` (strings), `link-list` ({label, href} pairs), or a `module-list` of card sub-modules for rich per-item structure$old$,
  $new$Repeating content is ONE `list` field holding N entries (list type `texts` for strings, `links` for label + link pairs, or a list type whose entries carry several parts), or a `module-list` of card sub-modules for rich per-item structure$new$),
  $old$If you are still unsure whether a repeat needs module-list, prefer `text-list`/`link-list` over any scalar fanout$old$,
  $new$If you are still unsure whether a repeat needs module-list, prefer a `list` field (`texts` / `links`) over any scalar fanout$new$),
  $old$(text-list / link-list / module-list for the repeating items)$old$,
  $new$(a `list` or `module-list` field for the repeating items)$new$)
WHERE slug IN ('manage-module', 'compose-page');

UPDATE skills
SET body = replace(replace(replace(
  body,
  $old$call build_page once with {page:{slug, title, name?}, modules:$old$,
  $new$call build_page once with {page:{slug, title, name?, pageType}, modules:$new$),
  $old$never bare literal HTML that leans on the extractor heuristic.$old$,
  $new$never bare literal HTML that leans on the extractor heuristic. Set `page.pageType` to what the page IS (list_page_types: a plain page, a news article, a product …) — typed pages also take `properties` and `terms`; a new kind of content is the manage-page-types skill.$new$),
  $old$(or initial create_page placements)$old$,
  $new$(or the initial build_page content)$new$),
    allowlisted_tools = (
      SELECT jsonb_agg(DISTINCT e)
      FROM jsonb_array_elements(allowlisted_tools || '["list_page_types"]'::jsonb) AS e
      WHERE e <> '"create_page"'::jsonb
    )
WHERE slug = 'compose-page';

------------------------------------------------------------------------
-- 5) Page-building skills set the page type.
------------------------------------------------------------------------
UPDATE skills
SET body = replace(
  body,
  $old$build the page with `build_page` (one call:$old$,
  $new$build the page with `build_page` (set `page.pageType` from list_page_types; one call:$new$)
WHERE slug = 'site-genesis';

UPDATE skills
SET body = replace(replace(replace(replace(
  body,
  $old$Navigation becomes a link-list field.$old$,
  $new$Navigation becomes a SHARED list (upsert_lists_many — type `menu`, or a mega-menu type; see the manage-menu skill) that the header / footer module's `list` field binds with `bind: "shared"`.$new$),
  $old$Build the type's modules + template following THE REBUILD CONTRACT$old$,
  $new$Make the type a Caelo page type (upsert_page_types_many with its template, properties and categories / tags vocabularies — manage-page-types skill), then build the type's modules + template following THE REBUILD CONTRACT$new$),
  $old$build it with `build_page` PASSING that import page id as `importPageId`$old$,
  $new$build it with `build_page` (with the type's `pageType`) PASSING that import page id as `importPageId`$new$),
  $old$the page (new via {slug, title}, or existing via {pageId})$old$,
  $new$the page (new via {slug, title, pageType}, or existing via {pageId})$new$)
WHERE slug = 'site-migrate';

UPDATE skills
SET body = replace(
  body,
  $old$Use it when a family of pages shares a shape (all blog posts, all product pages).$old$,
  $new$Use it when a family of pages shares a shape (all blog posts, all product pages). A template serves page types: pass `pageType` to add it to an existing type (list_page_types); a new kind of content is a new page type (manage-page-types skill).$new$),
    allowlisted_tools = (
      SELECT jsonb_agg(DISTINCT e)
      FROM jsonb_array_elements(allowlisted_tools || '["list_page_types"]'::jsonb) AS e
    )
WHERE slug = 'templates-layouts';

------------------------------------------------------------------------
-- 6) Remaining stale references.
------------------------------------------------------------------------
UPDATE skills
SET body = replace(
  body,
  $old$a navigation menu's structured set (`nav-menu/<slug>`)$old$,
  $new$an entry of a shared list (a menu, the footer links — fix it with patch_list_items_many)$new$)
WHERE slug = 'fix-quality-findings';

UPDATE skills
SET allowlisted_tools = (
      SELECT jsonb_agg(DISTINCT e)
      FROM jsonb_array_elements(allowlisted_tools) AS e
      WHERE e <> '"create_page"'::jsonb
    )
WHERE slug = 'bootstrap-site';

UPDATE skills
SET body = $menu_auditor_v2$You are a menu auditor running inside a subagent chat. Your single job: read the site's menus and return a verdict identifying issues.

Workflow:
1. Find every menu with `list_lists({role: "navigation"})` (menus, footer links and other navigation lists); read each with `get_list({slug})`.
2. For each entry with a link, check via `list_pages` (internal paths) or `find_redirects` whether it resolves to a real page. Dead links are issues.
3. Note duplicate or near-duplicate labels, unclear labels (e.g. "Stuff", "More"), inconsistent capitalization, and menus no module shows (empty usage).
4. Return a JSON verdict:

```json
{
  "pass": false,
  "issues": [
    {"type": "dead-link", "menuSlug": "main-menu", "label": "About us", "href": "/about-us"},
    {"type": "duplicate-label", "menuSlug": "main-menu", "labels": ["Blog", "Articles"]}
  ],
  "suggestions": ["short structural suggestion"]
}
```

You may NOT call any write tools. The parent will use your verdict to fix the menus with patch_list_items_many.$menu_auditor_v2$,
    allowlisted_tools = '["list_lists","get_list","find_redirects","list_pages"]'::jsonb
WHERE slug = 'menu-auditor';

UPDATE skills
SET allowlisted_tools = '["inspect_page_render","list_pages","list_lists","get_list"]'::jsonb
WHERE slug = 'qa-check';

COMMIT;
