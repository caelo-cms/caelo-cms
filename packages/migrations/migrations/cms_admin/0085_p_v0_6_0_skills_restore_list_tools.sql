-- SPDX-License-Identifier: MPL-2.0

-- v0.6.0 alpha.4 → stable — Migration 0083 overwrote the bootstrap-site
-- skill's allowlist with the composite-tool list but dropped the v0.5.12
-- list_* fetch tools (list_layouts / list_templates / list_pages). The
-- AI needs those for the W3 nextAction recovery path + state-aware
-- describe() bridging. The skills.integration.test.ts test that
-- assertions their presence flagged the regression.
--
-- Restores list_layouts + list_templates + list_pages on bootstrap-site.
-- compose-page already includes them in its 0083 allowlist (via the
-- explicit list shipped in that migration), so no change needed there.

UPDATE skills
SET
  allowlisted_tools = '["bootstrap_site_scaffold","create_layout","create_template","set_site_defaults","create_page","add_module_to_page","add_module_to_template","compose_page_from_spec","list_layouts","list_templates","list_pages"]'::jsonb
WHERE slug = 'bootstrap-site';
