-- SPDX-License-Identifier: MPL-2.0

-- Complete the tool-consolidation renames (audits #2/#3/#B, PRs #322/#323) in
-- the seeded skill data. Those PRs renamed/removed AI tools but never updated
-- the `compose-page` + `bootstrap-site` skill allowlists (or their teaching
-- bodies), so both skills carried DEAD tool names:
--
--   add_module_to_page / add_module_to_template / add_module_to_layout
--       → one `add_module` tool routed by `target` (#322)
--   change_template     → repoint_page_template (#B, PR #323)
--   compose_page_from_spec → build_page (retired in #313)
--
-- Why this is functional, not cosmetic: the chat-runner narrows the per-turn
-- catalogue to the union of engaged skills' allowlistedTools. compose-page and
-- bootstrap-site are the two primary BUILD skills. Their allowlists listed the
-- three old add-module names but NOT `add_module`, so whenever either engaged
-- the AI lost the ability to place modules — it kept edit_module/create_page
-- (still live in the list) so the zero-match "keep full catalogue" safety net
-- never tripped; it just silently degraded. Dead names resolve to nothing.
--
-- These allowlists were merged red (CI was failing on the stale skill tests
-- when #322/#323 went in via --admin); this migration + the companion test
-- updates make main green and pin the new names so the next rename that drops
-- them fails CI.
--
-- Idempotent: each UPDATE guards on the OLD name still being present.

-- ── allowlists ────────────────────────────────────────────────────────
UPDATE skills
SET allowlisted_tools = '["build_page","create_page","add_module","edit_module","reorder_module","move_module","repoint_page_template","duplicate_page","bootstrap_site_scaffold","create_layout","create_template","set_site_defaults","set_page_module_content","set_page_seo","autofill_page_seo","optimize_page_seo","set_site_identity","set_theme_tokens","set_theme_meta","list_theme_history","list_themes","get_theme","set_theme_asset"]'::jsonb
WHERE slug = 'compose-page'
  AND allowlisted_tools::text LIKE '%add_module_to_%';

UPDATE skills
SET allowlisted_tools = '["bootstrap_site_scaffold","create_layout","create_template","set_site_defaults","create_page","add_module","build_page","list_layouts","list_templates","list_pages","set_page_seo","autofill_page_seo","set_site_identity","set_theme_tokens","set_theme_meta","list_theme_history","list_themes","get_theme","set_theme_asset"]'::jsonb
WHERE slug = 'bootstrap-site'
  AND allowlisted_tools::text LIKE '%add_module_to_%';

-- ── teaching bodies ───────────────────────────────────────────────────
-- Both skills' bodies name the old tools. Targeted replace() per dead name —
-- none is a substring of another, so order is irrelevant. Guarded so re-runs
-- (and installs already on the new names) are no-ops.
UPDATE skills
SET body = replace(
             replace(
               replace(
                 replace(body,
                   'add_module_to_layout', 'add_module (target=''layout'')'),
                 'add_module_to_template', 'add_module (target=''template'')'),
               'add_module_to_page', 'add_module (target=''page'')'),
             'compose_page_from_spec', 'build_page')
WHERE slug IN ('compose-page', 'bootstrap-site')
  AND body IS NOT NULL
  AND (body LIKE '%add_module_to_%' OR body LIKE '%compose_page_from_spec%');
