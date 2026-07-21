-- SPDX-License-Identifier: MPL-2.0
--
-- 0170 — fix the templates-layouts (and manage-menu) skill bodies so the
-- AI reaches for the EXISTING layout when asked to put site-wide chrome
-- (a footer/header/nav) on every page, instead of falling back to
-- build_page.
--
-- Root cause (live e2e scenario-ai-layout-footer, issue #106 regression):
-- the AI correctly loaded `templates-layouts` and `add_module`
-- (target='layout') was a core, discoverable tool with the right
-- capability — but the loaded skill body framed the ENTIRE layouts
-- section through the Owner-gated `create_layout` two-step and gave no
-- direct, un-gated instruction for adding chrome to an ALREADY-EXISTING
-- layout, nor any contrast against build_page. A freshly loaded skill
-- body outweighs the always-on playbook, so the AI retreated from the
-- seemingly-gated layout path and built pages instead — leaving the
-- footer block empty (footerModuleCount=0).
--
-- Fix: lead the LAYOUTS section with the common un-gated case (add a
-- chrome module into the existing layout — one call, covers every page,
-- NOT build_page), and scope the Owner-gated create_layout strictly to
-- "no existing layout covers it". Mirror the exact call in manage-menu
-- (its description also matches "footer menu", so it can be the loaded
-- skill). Also widen the templates-layouts description so the skills
-- index points here for "footer/header on every page".
--
-- 0169 is already applied + idempotent (ON CONFLICT DO NOTHING), so the
-- body change must be a forward UPDATE migration. UPDATE ... WHERE slug
-- is itself idempotent (re-running is harmless).

BEGIN;

UPDATE skills SET
  description = 'Create and wire page-type templates and site layouts (chrome) — including putting a header, footer, or nav on every page. Engaged when the user wants a new page type, a shared header/footer shell, or to add/edit site-wide chrome.',
  body = 'You are working on templates (a page TYPE''s block structure) and layouts (the site shell / chrome shared across page types).

TEMPLATES (direct):
- create_template defines a reusable block structure from HTML with `<caelo-slot name="X">` markers — each slot becomes a block a page fills with modules. Use it when a family of pages shares a shape (all blog posts, all product pages).
- Bind a template to a layout with set_template_layout; move an existing page onto a different template with repoint_page_template.
- Fill a template''s shared blocks (content on EVERY page of that type) with add_module (target = "template").

LAYOUTS (the site chrome — the header/footer/nav shell wrapping every page):
- To put site-wide chrome on EVERY existing page, place the chrome module into the EXISTING layout''s block: add_module(target = "layout", targetRef = <the layout slug from list_layouts>, blockName = "footer" | "header"). That single call is the whole job — it covers all pages at once. Do NOT create or rebuild pages with build_page to host site-wide chrome, and do NOT loop per page.
- Creating a NEW layout is Owner-gated (two-step): create_layout only PROPOSES a layout — it queues a proposal the Owner approves at /security/layouts/pending. Do NOT claim the layout exists; tell the user you prepared it and they click Approve. Only propose a new layout when NO existing layout covers the chrome the user wants (e.g. a campaign shell with a banner and no footer) — otherwise reuse the existing layout and just add_module into it.
- After a new layout is approved, bind templates via set_template_layout or fill its blocks via add_module (target = "layout").

Prefer reusing an existing template/layout over minting a new one — check list_templates / list_layouts first.'
WHERE slug = 'templates-layouts';

UPDATE skills SET
  body = 'You are building or editing site navigation — header menus, footer menus, and other link groups.

Navigation menus are STRUCTURED SETS of kind `nav-menu` — not raw HTML, and not numbered module fields. Common slugs: `header-main`, `footer-main`.

1. Read before you write. The current sets and their items are inlined in the `# Structured-data sets you can edit` system block. Copy the existing items and modify them — do not re-invent the menu from scratch. If a set is not inlined (its item cap was exceeded, or it is a different kind), call `get_structured_set({kind, slug})` first.
2. Write with `set_structured_set({kind: "nav-menu", slug, displayName, items})`. It is an UPSERT that REPLACES the whole items list — always pass the FULL desired menu, not just the additions. There is no append.
3. Every link target must resolve to a REAL page. If the user asks for a menu entry whose target page does not exist yet, create the missing page with build_page and link to its slug. Do not stall asking the operator which page to point at, and never link to a dead URL.
4. A chrome module (header / footer) renders the menu. If the menu does not yet appear site-wide, place a header/footer module that consumes it into the EXISTING layout with add_module(target = "layout", blockName = "footer" | "header") — one call covers every page. Do NOT use build_page to put site-wide chrome on the site.
5. For a SMALL link group that lives inside ONE module only (social icons in a hero, inline legal links in a footer band), use a `link-list` FIELD on that module instead of a shared nav-menu set. Reserve nav-menu sets for navigation reused across pages.

Keep labels short and consistent; match the site''s existing capitalisation and voice.'
WHERE slug = 'manage-menu';

COMMIT;
