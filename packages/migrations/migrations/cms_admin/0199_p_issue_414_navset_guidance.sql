-- SPDX-License-Identifier: MPL-2.0
--
-- 0199 — issue #414 (immediate scope): make the nav-menu / structured-set
-- skill guidance factually match the implemented renderer, and document
-- `{{#module-list}}` semantics AI-facing.
--
-- Ground truth (audited 2026-08-03; this migration changes guidance ONLY,
-- not behaviour):
--   * The ONLY binding between a `nav-menu/<set-slug>` structured set and
--     the rendered site is a module-slug convention: `lookupNavMenuItems`
--     (packages/shared/src/preview-compose.ts) matches modules whose slug
--     starts with `nav-menu-`; on a hit the module's stored HTML is
--     DISCARDED and replaced by `renderNavMenuHtml`, whose `renderNavItem`
--     DOES recurse `children` into nested <ul> submenus — and the item
--     schema (packages/shared/src/structured-sets.ts `navMenuItem`) is
--     recursive too. The binding applies only at the compose call sites
--     (modules placed directly in layout/page blocks), never to modules
--     nested via `module`/`module-list` fields (preview-render path).
--     Twin convention: `language-selector-<set-slug>`.
--   * No AI tool can produce such a slug: `slugifyModuleName` always
--     appends a base36 timestamp suffix; exact slugs are admin-UI-only.
--     Issue #414 tracks the binding-mechanism decision — until it lands,
--     the reachable chrome-nav path is a `link-list` field on the chrome
--     module (flat {label, href} pairs; no children).
--   * `module`/`module-list` fields are REJECTED on layout/template
--     placements (`findUnrenderableLayoutFields` — chrome placements have
--     no content_instance to fill them). 0180's guidance prescribing "a
--     header module with a module-list FIELD of panel sub-modules" was
--     therefore impossible to follow, and its "a nav-menu set renders
--     FLAT … NO nested iteration" claim was false (see the recursion
--     above). Both corrected below.
--   * `{{#field}}` over a `module-list` DISCARDS the inner template block
--     entirely (template-engine.ts `renderModuleList`); elements are
--     {moduleId, contentInstanceId} refs rendered as pre-resolved
--     partials, on the DB-aware render path only.
--   * The `# Structured-data sets you can edit` system-prompt block was
--     removed in d669e481 (fully-static-prompt rework; its formatter
--     survives only as dead code) — skills 0168/0170 still pointed the AI
--     at it. The matching stale pointers in the structured-set tool
--     descriptions are fixed in code in this same change.
--
-- History-note (0092 is immutable, corrected here instead): 0092's
-- comment says the `nav-menu-header-main` module-slug convention is
-- "documented in the v0.10.21 system-prompt primer" — that primer is the
-- block removed in d669e481. The convention's live AI-facing
-- documentation is the manage-menu skill body below plus the
-- structured-set tool descriptions.
--
-- Mechanics: manage-menu gets a full-body UPDATE (0170 precedent — the
-- errors span three separate list items, so per-error surgical replaces
-- would be more fragile than restating the body); its allowlist gains
-- `list_modules` because the new step 4 tells the AI to CHECK for a bound
-- `nav-menu-<set-slug>` module before deciding how to render. manage-module
-- gets a marker-guarded surgical replace() (0180 pattern) because later
-- migrations (0196) append paragraphs to that body — a full restate would
-- silently drop them. Both statements are idempotent on re-run.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

------------------------------------------------------------------------
-- 1) manage-menu — honest visibility contract + corrected dropdown
--    guidance (replaces 0170's body + 0180's item 6).
------------------------------------------------------------------------
UPDATE skills
SET body = $manage_menu_v3$You are building or editing site navigation — header menus, footer menus, and other link groups.

Navigation menus are STRUCTURED SETS of kind `nav-menu` — not raw HTML, and not numbered module fields. Common slugs: `header-main`, `footer-main`. Items are `{label, href[, target, children]}` — `children` nests submenu items (the shape is recursive).

1. Read before you write. Sets are NOT inlined in the system prompt — call `get_structured_set({kind, slug})` (or `list_structured_sets` to discover what exists) and modify the current items; do not re-invent the menu from scratch.
2. Write with `set_structured_set({kind: "nav-menu", slug, displayName, items})`. It is an UPSERT that REPLACES the whole items list — always pass the FULL desired menu, not just the additions. There is no append.
3. Every link target must resolve to a REAL page. If the user asks for a menu entry whose target page does not exist yet, create the missing page with build_page and link to its slug. Do not stall asking the operator which page to point at, and never link to a dead URL.
4. HOW a set becomes visible — the honest contract. Writing a set does NOT by itself change the site. The only built-in binding matches a module whose slug is EXACTLY `nav-menu-<set-slug>` (e.g. `nav-menu-header-main` renders the `nav-menu/header-main` set), placed directly in a layout or page block — a module nested inside another module (via `module`/`module-list` fields) never gets the binding. On a match the module's OWN stored HTML is discarded and replaced by the built-in nav renderer (`<nav class="caelo-nav-menu">`, with `children` rendered as nested `<ul>` submenus). NO AI TOOL can currently create such a slug — minted module slugs always carry a generated suffix; exact slugs are admin-UI-only (issue #414 tracks making this reachable). So: check `list_modules` for a `nav-menu-<set-slug>` module first. If one exists on the layout, edit the set and the site follows. If none exists, do NOT try to mint one — render the nav in the chrome (header/footer) module itself via a `link-list` FIELD with a `default`, placed on the EXISTING layout with add_module(target = "layout", blockName = "footer" | "header") — one call covers every page. Do NOT use build_page to put site-wide chrome on the site.
5. For a SMALL link group that lives inside ONE module only (social icons in a hero, inline legal links in a footer band), use a `link-list` FIELD on that module instead of a shared nav-menu set. Reserve nav-menu sets for navigation reused across pages.
6. DROPDOWNS / multi-level menus. A `nav-menu` set DOES support nesting: give an item `children` and the built-in renderer emits nested `<ul>` submenus — but that renderer is only reachable through the slug binding in step 4. A `link-list` FIELD is FLAT — its items are `{label, href}` pairs with no children, so a link-list nav cannot express dropdowns. And on site chrome there is NO sub-module escape hatch: `module`/`module-list` fields are REJECTED on layout/template placements (they need a content_instance, which chrome placements do not have). For a dropdown or mega menu today, author the submenu/panel markup directly in the chrome module's HTML — static structure, with a `link-list` field (+ `default`) per flat link group inside it.

Keep labels short and consistent; match the site's existing capitalisation and voice.$manage_menu_v3$,
    allowlisted_tools = '["set_structured_set","get_structured_set","list_structured_sets","delete_structured_set","build_page","add_module","list_pages","list_modules"]'::jsonb
WHERE slug = 'manage-menu';

------------------------------------------------------------------------
-- 2) manage-module — document {{#module-list}} section semantics next to
--    the existing text-list/link-list section guidance (item 4).
------------------------------------------------------------------------
UPDATE skills
SET body = replace(
  body,
  $anchor$inside a section are per-item locals, not separate fields.$anchor$,
  $new$inside a section are per-item locals, not separate fields. A `module-list` section is DIFFERENT: the engine DISCARDS the inner block entirely — write `{{#slides}}{{/slides}}` as a pure insertion marker and never put markup inside it. Each element is a `{moduleId, contentInstanceId}` ref, and the engine renders each referenced module's OWN HTML in its place (recursive, depth-capped at 8). A module-list needs a content_instance to fill it, so it renders on PAGES only — on layout/template chrome, `module`/`module-list` fields are REJECTED at add time; model repeated chrome content as a `link-list`/`text-list` field with a `default` instead.$new$
)
WHERE slug = 'manage-module'
  AND body NOT LIKE '%A `module-list` section is DIFFERENT%';

COMMIT;
