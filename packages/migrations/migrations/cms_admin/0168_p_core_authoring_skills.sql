-- SPDX-License-Identifier: MPL-2.0
--
-- 0168 — a skill per core authoring domain (pages / modules / menus).
--
-- CLAUDE.md §2 "Skills are the official way to teach AI new behaviour" +
-- the AI-first principle (§1A): every LARGER task the operator describes
-- in outcomes ("build a card", "add a footer menu", "edit this page")
-- should have a skill that hands the AI the right call shape without a
-- round-trip. Today only page COMPOSITION (compose-page) is covered as a
-- domain skill; there is no module-authoring skill and no menu-authoring
-- skill (menu-auditor only AUDITS). This migration:
--   1. broadens `compose-page` from create-only to the page DOMAIN skill
--      (create + edit), and
--   2. seeds `manage-module` and `manage-menu`.
--
-- Provider-neutral by design: these are Caelo behavioural skills (custom
-- matcher + Owner-activation + RLS), NOT Anthropic native container
-- skills — so they work identically across every provider behind the
-- abstraction layer (§3).
--
-- Idempotent: new skills use ON CONFLICT (slug) DO NOTHING; the
-- compose-page edits are marker-guarded so operator edits win + re-runs
-- are no-ops. All allowlist tool names are validated live against
-- `liveToolNames()` by the #301 skills tests.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

------------------------------------------------------------------------
-- 1) compose-page becomes the PAGE domain skill: create + edit.
------------------------------------------------------------------------
UPDATE skills
SET display_name = 'Create & edit pages',
    description  = 'Create new pages from modules and edit existing ones — structure, per-page content, status, and template. Engaged when the user asks to build, fill, or change a page.'
WHERE slug = 'compose-page';

-- Broaden the allowlist with the edit-path tools (dedup-safe union).
UPDATE skills
SET allowlisted_tools = (
  SELECT jsonb_agg(DISTINCT e)
  FROM jsonb_array_elements(
    allowlisted_tools ||
    '["set_page_module_content","set_page_module_content_many","set_pages_status_many","update_pages_many","remove_module_from","repoint_page_template"]'::jsonb
  ) AS e
)
WHERE slug = 'compose-page';

-- Broaden auto-engagement to the edit vocabulary (keep create keywords).
UPDATE skills
SET auto_engagement_hints =
  '{"keywords":["create","new page","build a page","compose","add page","make a page","start a page","edit page","edit this page","change the page","update the page","rename page","reorder","move section","delete page","publish","unpublish","page status","duplicate page"],"chipTrigger":false,"alwaysOn":false}'::jsonb
WHERE slug = 'compose-page';

-- Teach the editing path. Marker-guarded: only when absent.
UPDATE skills
SET body = body || '

EDITING an existing page (not only composing new ones):
- Structure: add / remove / reorder / move modules with add_module, remove_module_from, reorder_module, move_module. Reuse existing module ids when the content already exists.
- Copy on THIS page only: set_page_module_content (per-placement content). This does NOT change the module anywhere else. Editing the module itself changes every page that references it — choose per-placement content unless the change is meant to be global (that is the manage-module skill).
- Status: set_pages_status_many to publish / unpublish (draft to live). Rename or metadata: update_pages_many. Renaming a page slug automatically creates a redirect from the old URL — Caelo does this for you, so never leave the old URL dead.
- Template: repoint_page_template to move a page onto a different template.
Confirm in one sentence what you changed and where.'
WHERE slug = 'compose-page'
  AND body NOT LIKE '%EDITING an existing page%';

------------------------------------------------------------------------
-- 2) manage-module — author + revise reusable modules (§1A).
------------------------------------------------------------------------
INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES
  (
    'manage-module',
    'Create & edit modules',
    'Author and revise reusable modules — the heroes, cards, banners, CTAs, headers and footers that pages reference. Engaged when the user asks to create, change, or restyle a block/component rather than a whole page.',
    'You are authoring or revising a reusable module — the building blocks pages reference. A page never carries raw HTML; the HTML always lives in a module.

CREATE a module (add_module):
1. Author the HTML with `{{field}}` placeholders for every value a non-technical operator would edit (headings, body copy, button labels, hrefs, image srcs, list items), AND declare a matching `fields[]` entry for each — in the SAME call. Authoring fields yourself is the canonical path: it skips the inference round-trip and the server-side extractor heuristic. Only throw bare HTML with no fields when the markup is messy human paste you cannot cleanly parametrise.
2. Name each field in semantic snake_case that describes the VALUE, never the tag: `hero_title`, `primary_cta_href`, `nav_items` — never `h1`, `label`, `label2`.
3. Pick the right kind per field: text, richtext, url, image, number, boolean, link. REPEATING content is ONE list field (`text-list`, `link-list`, or a `module-list` of sub-modules) holding N items — never numbered scalars (`item`, `item2`, `item3`).
4. List fields render with MUSTACHE SECTIONS, never Handlebars — never write `{{this}}`. A text-list iterates as `{{#features}}<li>{{.}}</li>{{/features}}` (`{{.}}` is the current string item). A link-list iterates as `{{#links}}<a href="{{href}}">{{label}}</a>{{/links}}` (`{{href}}` / `{{label}}` are the per-item keys). The section name and its enclosing field are the ONLY declared fields; `{{.}}` / `{{href}}` / `{{label}}` inside a section are per-item locals, not separate fields.
5. Every field carries `default` = the exact original value it replaced (the heading text, the href, the label). A link-list default is an array of `{label, href}`; a text-list default is an array of strings. Placements with no custom content render these defaults — dropping a default loses the copy.
6. Set `kind` (chrome | hero | content | cta | utility), a short `displayName`, and a one-line `description` (what it is + when to use it). That description is decision-support for reuse later — write it for the next author.
7. Brand assets use the reserved theme placeholders (`{{theme_logo_url}}`, `{{theme_logo_dark_url}}`, `{{theme_favicon_url}}`, `{{theme_social_share_url}}`) rather than hard-coded srcs; content imagery comes from `find_media` / `generate_image`.

REVISE a module (edit_module): changing the module HTML/CSS/fields changes it EVERYWHERE it is placed. If the user wants to change only one page, that is per-placement content (set_page_module_content on the page), NOT a module edit. When you add or rename a `{{field}}`, update `fields[]` in the same call so the placeholder-to-field contract holds.

REUSE before you mint: check list_modules / the ## Modules block for a module whose description fits. A card that exists is a reuse (add_module with its id), not a new module.',
    '["add_module","edit_module","list_modules","remove_module_from","get_theme","find_media","generate_image"]'::jsonb,
    '{"keywords":["module","component","reusable block","building block","hero block","card","banner","cta block","widget","restyle the block","edit the module","make a block"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  )
ON CONFLICT (slug) DO NOTHING;

------------------------------------------------------------------------
-- 3) manage-menu — author + edit navigation (structured sets).
------------------------------------------------------------------------
INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES
  (
    'manage-menu',
    'Create & edit menus',
    'Build and edit site navigation — header menus, footer menus, and other link groups. Engaged when the user asks to add, remove, or reorder navigation links.',
    'You are building or editing site navigation — header menus, footer menus, and other link groups.

Navigation menus are STRUCTURED SETS of kind `nav-menu` — not raw HTML, and not numbered module fields. Common slugs: `header-main`, `footer-main`.

1. Read before you write. The current sets and their items are inlined in the `# Structured-data sets you can edit` system block. Copy the existing items and modify them — do not re-invent the menu from scratch. If a set is not inlined (its item cap was exceeded, or it is a different kind), call `get_structured_set({kind, slug})` first.
2. Write with `set_structured_set({kind: "nav-menu", slug, displayName, items})`. It is an UPSERT that REPLACES the whole items list — always pass the FULL desired menu, not just the additions. There is no append.
3. Every link target must resolve to a REAL page. If the user asks for a menu entry whose target page does not exist yet, create the missing page with build_page and link to its slug. Do not stall asking the operator which page to point at, and never link to a dead URL.
4. A chrome module (header / footer) renders the menu. If the menu does not yet appear on the site, make sure a header/footer module that consumes it is placed on the layout.
5. For a SMALL link group that lives inside ONE module only (social icons in a hero, inline legal links in a footer band), use a `link-list` FIELD on that module instead of a shared nav-menu set. Reserve nav-menu sets for navigation reused across pages.

Keep labels short and consistent; match the site''s existing capitalisation and voice.',
    '["set_structured_set","get_structured_set","list_structured_sets","delete_structured_set","build_page","add_module","list_pages"]'::jsonb,
    '{"keywords":["menu","navigation","navbar","nav menu","header menu","footer menu","nav link","menu item","add to the menu","reorder the menu","navigation links"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  )
ON CONFLICT (slug) DO NOTHING;

COMMIT;
