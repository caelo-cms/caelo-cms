-- SPDX-License-Identifier: MPL-2.0

-- v0.6.1 — compose-page + bootstrap-site skill allowlists didn't include
-- set_page_seo / autofill_page_seo / optimize_page_seo, so when either
-- skill engaged with real intent (any "build a page" prompt) the chat-
-- runner's allowlist filter at chat-runner.ts:938-988 stripped SEO
-- tools from the AI's per-turn catalogue. The AI then correctly
-- reported "I don't have a tool for that" because from its view it
-- genuinely didn't.
--
-- Same root-cause pattern as v0.6.0-alpha.4's list_* missing from
-- bootstrap-site allowlist (migration 0085). This restores the missing
-- SEO tools so the AI sees them on every "compose / build" turn.
--
-- Idempotent: only updates when the allowlist doesn't already mention
-- set_page_seo. Safe to re-run.

UPDATE skills
SET
  allowlisted_tools = '["compose_page_from_spec","create_page","add_module_to_page","add_module_to_template","edit_module","reorder_module","move_module","change_template","duplicate_page","bootstrap_site_scaffold","create_layout","create_template","set_site_defaults","set_page_module_content","set_page_seo","autofill_page_seo","optimize_page_seo"]'::jsonb
WHERE slug = 'compose-page'
  AND allowlisted_tools::text NOT LIKE '%set_page_seo%';

UPDATE skills
SET
  allowlisted_tools = '["bootstrap_site_scaffold","create_layout","create_template","set_site_defaults","create_page","add_module_to_page","add_module_to_template","compose_page_from_spec","list_layouts","list_templates","list_pages","set_page_seo","autofill_page_seo"]'::jsonb
WHERE slug = 'bootstrap-site'
  AND allowlisted_tools::text NOT LIKE '%set_page_seo%';
