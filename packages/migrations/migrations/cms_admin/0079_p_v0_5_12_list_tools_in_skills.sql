-- SPDX-License-Identifier: MPL-2.0

-- v0.5.12 — patch compose-page + bootstrap-site skill bodies to point
-- the AI at the new list_layouts / list_templates / list_pages tools.
--
-- Pre-v0.5.12 the AI's only window into existing site state was the
-- system-prompt context blocks (# Layouts on this site, # Templates →
-- layouts, # All pages). When the AI claimed it didn't have a UUID
-- (real or hallucinated), it had no fetch path — it asked the operator.
-- v0.5.12 ships the read tools; this migration tells the skills to USE
-- them.

UPDATE skills
SET body = 'You are bootstrapping a fresh Caelo install. The site has no layouts, no templates, or no site_defaults yet — and the user wants to build pages on it.

Do NOT ask the operator to create layouts / templates manually. Do NOT ask the operator to paste UUIDs you can fetch yourself. You have the tools. Execute this chain:

1. create_layout — make ONE layout with at least three blocks: header, content, footer. Slug it ''default''. The header + footer blocks are where the site nav + footer modules attach (later, via add_module_to_template). NOTE: create_layout is propose/execute gated — the Owner clicks Approve in the chat panel.
2. After Approve: call list_layouts to fetch the new layout''s UUID. Do not ask the operator for it — the data is one tool call away.
3. create_template — make at least one template pointing at the layout UUID from list_layouts. Slug it ''marketing'' (or whatever fits the user''s ask). If the user asked for both a homepage AND stub pages, create a second ''stub'' template too. After create_template returns, call list_templates to fetch the new template UUIDs.
4. set_site_defaults — point at the layout + template UUIDs (from list_layouts / list_templates).
5. Then proceed to the user''s original request (typically: compose-page workflow to actually build the page).

This chain runs across as few turns as possible. The only mandatory pause is after step 1 (Owner clicks Approve in the chat panel). After Approve, immediately call list_layouts to read the new UUID and continue with the next step. Do not pause for any other reason.

If a tool returns a structured error (e.g. "slug already exists"), pick a different slug and continue.

If the user asks specifically for multiple templates (e.g. ''marketing'' for the homepage and ''stub'' for placeholder pages), create both before set_site_defaults. set_site_defaults points at the most general template; per-page creates can override.'
WHERE slug = 'bootstrap-site';

UPDATE skills
SET body = 'You are composing a page from existing or newly-created modules.

Workflow:
0. If no templates or layouts exist on this site (see the Site defaults / Layouts context blocks, or call list_layouts / list_templates), bootstrap them FIRST by calling create_layout → create_template → set_site_defaults. Do NOT ask the operator to do this — these tools are available to you. The bootstrap-site skill engages alongside this one when the site is empty.
1. Identify the page''s purpose (landing, blog post, contact, etc.) from the user''s prompt.
2. Pick the right templateId for that purpose. Use the All-pages and Layouts context blocks to find existing pages with similar shape. If a UUID you need isn''t in the blocks (stale right after a create), call list_layouts / list_templates / list_pages directly — do NOT ask the operator to paste a UUID.
3. Add modules via add_module_to_page (one page) or add_module_to_template (every page on a template). Reuse existing module ids when the content already exists; only create new modules when nothing fits.
4. Pick or create modules whose declared field schemas match the content you need. Module HTML is a template referencing fields as {{fieldName}}; per-page content lives in field values set via set_page_module_content (or initial create_page placements).
5. Lay out the page block-by-block (header → content → footer when the layout has those blocks).
6. After composing, give the user a one-sentence summary of what you built and which blocks contain which modules.

Pages reference modules only — never put literal HTML on a page row. Edits to module code propagate to every page using the module; edits to page content stay scoped to that placement.',
  allowlisted_tools = '["create_page","add_module_to_page","add_module_to_template","edit_module","reorder_module","move_module","change_template","duplicate_page","create_layout","create_template","set_site_defaults","set_page_module_content","list_layouts","list_templates","list_pages"]'::jsonb
WHERE slug = 'compose-page';

UPDATE skills
SET
  allowlisted_tools = '["create_layout","create_template","set_site_defaults","create_page","add_module_to_page","add_module_to_template","list_layouts","list_templates","list_pages"]'::jsonb
WHERE slug = 'bootstrap-site';
