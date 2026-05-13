-- SPDX-License-Identifier: MPL-2.0

-- v0.5.10 — skill body cleanup + new bootstrap-site skill.
--
-- Three problems traced to skill bodies + system-prompt blocks were
-- causing the AI to refuse to bootstrap an empty install. The
-- compose-page skill cited "CLAUDE.md §2" (a file the AI cannot
-- access) and assumed templates already exist. The siteDefaultsBlock
-- (chat-runner.ts) told the AI to "ask the operator" when no
-- templates existed — actively priming passive behavior. And there
-- was no skill that engaged on fresh-install bootstrap requests.
--
-- This migration:
--   1. UPDATEs compose-page — drops the CLAUDE.md citation, replaces
--      "Use semantic HTML inside each module" with field-schema
--      guidance, adds a "if templates exist; otherwise bootstrap"
--      branch, extends the tool allowlist with create_layout +
--      create_template + set_site_defaults.
--   2. INSERTs bootstrap-site — a new skill that auto-engages on
--      site-build keywords and walks the canonical layout →
--      template → site_defaults → page chain.
--   3. UPDATEs brand-voice-guard — tightens to 3 sentences from
--      5 numbered rules; drops "re-read them on every turn" since
--      the memory blocks render every turn by construction.

UPDATE skills
SET
  body = 'You are composing a page from existing or newly-created modules.

Workflow:
0. If no templates or layouts exist on this site (see the Site defaults / Layouts context blocks), bootstrap them FIRST by calling create_layout → create_template → set_site_defaults. Do NOT ask the operator to do this — these tools are available to you. The bootstrap-site skill engages alongside this one when the site is empty.
1. Identify the page''s purpose (landing, blog post, contact, etc.) from the user''s prompt.
2. Pick the right templateId for that purpose. Use the All-pages and Layouts context blocks to find existing pages with similar shape.
3. Add modules via add_module_to_page (one page) or add_module_to_template (every page on a template). Reuse existing module ids when the content already exists; only create new modules when nothing fits.
4. Pick or create modules whose declared field schemas match the content you need. Module HTML is a template referencing fields as {{fieldName}}; per-page content lives in field values set via set_page_module_content (or initial create_page placements).
5. Lay out the page block-by-block (header → content → footer when the layout has those blocks).
6. After composing, give the user a one-sentence summary of what you built and which blocks contain which modules.

Pages reference modules only — never put literal HTML on a page row. Edits to module code propagate to every page using the module; edits to page content stay scoped to that placement.',
  allowlisted_tools = '["create_page","add_module_to_page","add_module_to_template","edit_module","reorder_module","move_module","change_template","duplicate_page","create_layout","create_template","set_site_defaults","set_page_module_content"]'::jsonb
WHERE slug = 'compose-page';

UPDATE skills
SET
  body = 'You are the brand-voice gatekeeper for every word of new or edited copy.

Match the ## Brand voice, ## Tone, and ## Glossary memory slots verbatim. Phrases in the ## Banned phrases slot MUST NOT appear in any generated text — reword.

When the user gives a new persistent voice/tone instruction (e.g. "make all copy more casual"), call site_memory_propose so the Owner can persist it.'
WHERE slug = 'brand-voice-guard';

INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES (
  'bootstrap-site',
  'Bootstrap a fresh install',
  'Engages when the user asks to build / set up a site that has no templates or layouts yet. Walks the canonical scaffold chain.',
  'You are bootstrapping a fresh Caelo install. The site has no layouts, no templates, or no site_defaults yet — and the user wants to build pages on it.

Do NOT ask the operator to create layouts / templates manually. You have the tools. Execute this chain:

1. create_layout — make ONE layout with at least three blocks: header, content, footer. Slug it ''default''. The header + footer blocks are where the site nav + footer modules attach (later, via add_module_to_template).
2. create_template — make at least one template pointing at the layout you just created. Slug it ''marketing'' (or whatever fits the user''s ask). If the user asked for both a homepage AND stub pages, create a second ''stub'' template too.
3. set_site_defaults — point at the layout + template you just created so subsequent create_page calls don''t need explicit templateId.
4. Then proceed to the user''s original request (typically: compose-page workflow to actually build the page).

This whole chain runs in one turn — do not pause and ask the operator between steps. If a tool returns a structured error (e.g. "slug already exists"), pick a different slug and continue.

If the user asks specifically for multiple templates (e.g. ''marketing'' for the homepage and ''stub'' for placeholder pages), create both before set_site_defaults. set_site_defaults points at the most general template; per-page creates can override.',
  '["create_layout","create_template","set_site_defaults","create_page","add_module_to_page","add_module_to_template"]'::jsonb,
  '{"keywords":["build the homepage","build the site","set up the site","scaffold","bootstrap","fresh install","empty site","no templates","start the site"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
  'active'
);
