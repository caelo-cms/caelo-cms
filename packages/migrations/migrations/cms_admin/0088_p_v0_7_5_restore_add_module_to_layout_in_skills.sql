-- SPDX-License-Identifier: MPL-2.0

-- v0.7.5 — restore add_module_to_layout to the bootstrap-site +
-- compose-page allowlists. The tool is registered globally (see
-- ai/tools/index.ts:129) but the chat-runner narrows the per-turn
-- catalogue to the union of engaged skills' allowlistedTools
-- (chat-runner.ts:920-944). When bootstrap-site engages on a fresh
-- install AND its allowlist doesn't include add_module_to_layout,
-- the AI literally cannot see the tool and reports "isn't in my
-- toolset on this build" — falling back to stuffing header / footer
-- modules into the page's content block (wrong: chrome belongs on
-- the layout so it appears on every page).
--
-- Regression chain:
--   0081 (v0.5.18): added add_module_to_layout to bootstrap-site —
--     fix for the exact symptom we're seeing again now.
--   0083 (v0.6.0):  rewrote bootstrap-site + compose-page allowlists
--     to point at composite tools; dropped add_module_to_layout
--     from BOTH without preserving it.
--   0085 (v0.6.0):  restored list_layouts / list_templates /
--     list_pages (which the test caught) — but the test never
--     asserted add_module_to_layout, so the gap continued.
--   0086 (v0.6.1):  added SEO tools; perpetuated the gap.
--   0088 (v0.7.5):  this migration restores the tool to both
--     allowlists AND extends the bootstrap-site body to teach the
--     AI when to reach for it. The companion change to
--     skills.integration.test.ts adds toContain assertions so the
--     next allowlist rewrite that drops it fails CI.
--
-- Idempotent: each UPDATE guards on NOT LIKE '%add_module_to_layout%'
-- (same pattern as 0086). Safe to re-run.

UPDATE skills
SET
  allowlisted_tools = '["bootstrap_site_scaffold","create_layout","create_template","set_site_defaults","create_page","add_module_to_page","add_module_to_template","add_module_to_layout","compose_page_from_spec","list_layouts","list_templates","list_pages","set_page_seo","autofill_page_seo"]'::jsonb
WHERE slug = 'bootstrap-site'
  AND allowlisted_tools::text NOT LIKE '%add_module_to_layout%';

UPDATE skills
SET
  allowlisted_tools = '["compose_page_from_spec","create_page","add_module_to_page","add_module_to_template","add_module_to_layout","edit_module","reorder_module","move_module","change_template","duplicate_page","bootstrap_site_scaffold","create_layout","create_template","set_site_defaults","set_page_module_content","set_page_seo","autofill_page_seo","optimize_page_seo"]'::jsonb
WHERE slug = 'compose-page'
  AND allowlisted_tools::text NOT LIKE '%add_module_to_layout%';

-- Teach the AI explicitly that header / footer / nav chrome belongs on
-- the layout, not the template or a page's content block. Belt-and-
-- braces with the chrome-block nextAction hint in
-- add_module_to_template.ts:270-310 (which is reactive — the AI has to
-- pick the wrong tool first). The skill body is preventive: the AI
-- sees this teaching text every time the skill engages, BEFORE it
-- writes a tool call.
--
-- Idempotent via NOT LIKE on the new sentinel paragraph.
UPDATE skills
SET
  body = 'You are bootstrapping a fresh Caelo install. The site has no layouts, no templates, or no site_defaults yet — and the user wants to build pages on it.

PREFERRED PATH: call bootstrap_site_scaffold once. It is idempotent and makes forward progress on whichever stage is incomplete:
- STAGE 0 (no layout): queues a layouts.create proposal — Owner clicks Approve at /security/layouts/pending.
- STAGE 1 (layout exists, no template): creates the template directly.
- STAGE 2 (defaults missing): pins site_defaults directly.
- STAGE 3 (all three exist): no-op.

After Owner approves the STAGE 0 proposal, call bootstrap_site_scaffold again to continue.

Then proceed with the user''s original request (compose-page workflow to actually build the page content).

LAYOUT-LEVEL CHROME: when the user wants a header, footer, nav, sidebar, or banner that should appear on EVERY page, those are layout-level chrome — call add_module_to_layout with layoutSlug from the bootstrap result (default "site-default"). Do NOT use add_module_to_template (templates only carry the per-page content block) and do NOT stuff chrome modules into a page''s content block (they won''t appear on other pages and every future content edit fights them).

ESCAPE HATCH: granular tools (create_layout, create_template, set_site_defaults) remain available if you need a non-default block list, multiple templates, or other custom scaffold shape. The composite covers the 95% case; reach for the granular tools only when the user asked for something specific the composite cannot express.'
WHERE slug = 'bootstrap-site'
  AND body NOT LIKE '%LAYOUT-LEVEL CHROME%';
