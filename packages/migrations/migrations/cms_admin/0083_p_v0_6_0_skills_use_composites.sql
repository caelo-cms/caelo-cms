-- SPDX-License-Identifier: MPL-2.0

-- v0.6.0 — point the bootstrap-site + compose-page skill bodies at the
-- new composite tools (bootstrap_site_scaffold, compose_page_from_spec)
-- so the AI knows to prefer them over the multi-step orchestration the
-- v0.5.10 bodies described.
--
-- Why: shipping the composites without updating the skill bodies leaves
-- the AI orchestrating create_layout → create_template →
-- set_site_defaults → create_page even though one composite call now
-- does the whole chain (with idempotent forward-progress across the
-- Owner-approval gap). The composites also have state-aware describe()
-- callbacks so the AI sees exactly what the next call will do.
--
-- Granular tools stay in the allowlist as the escape hatch for the
-- edge cases composites don't cover.

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

ESCAPE HATCH: granular tools (create_layout, create_template, set_site_defaults) remain available if you need a non-default block list, multiple templates, or other custom scaffold shape. The composite covers the 95% case; reach for the granular tools only when the user asked for something specific the composite cannot express.'
WHERE slug = 'bootstrap-site';

UPDATE skills
SET
  body = 'You are composing a page from existing or newly-created modules.

Workflow:
0. If no templates or layouts exist on this site (see the Site defaults / Layouts context blocks), bootstrap them FIRST via the bootstrap-site skill (calls bootstrap_site_scaffold). Do NOT ask the operator to do this — these tools are available to you.

1. Identify the page''s purpose (landing, blog post, contact, etc.) from the user''s prompt.

2. PREFERRED for multi-section pages: call compose_page_from_spec once with {slug, name, title, sections:[{displayName, html, css?, js?}]}. The handler creates the page + creates and attaches each section as a module on the content block in one tx-like call. Saves N+1 round-trips vs. orchestrating create_page + add_module_to_page individually. Per-section failures are reported but the page is NOT rolled back.

3. ESCAPE HATCH for incremental builds: when adding ONE section to an existing page, use add_module_to_page directly. When the user is iterating ("now add a testimonials block, then a CTA"), individual add_module_to_page calls are clearer than re-running the composite.

4. Pick or create modules whose declared field schemas match the content you need. Module HTML is a template referencing fields as {{fieldName}}; per-page content lives in field values set via set_page_module_content (or initial create_page placements).

5. After composing, give the user a one-sentence summary of what you built and which blocks contain which modules.

Pages reference modules only — never put literal HTML on a page row. Edits to module code propagate to every page using the module; edits to page content stay scoped to that placement.',
  allowlisted_tools = '["compose_page_from_spec","create_page","add_module_to_page","add_module_to_template","edit_module","reorder_module","move_module","change_template","duplicate_page","bootstrap_site_scaffold","create_layout","create_template","set_site_defaults","set_page_module_content"]'::jsonb
WHERE slug = 'compose-page';

UPDATE skills
SET
  allowlisted_tools = '["bootstrap_site_scaffold","create_layout","create_template","set_site_defaults","create_page","add_module_to_page","add_module_to_template","compose_page_from_spec"]'::jsonb
WHERE slug = 'bootstrap-site';
