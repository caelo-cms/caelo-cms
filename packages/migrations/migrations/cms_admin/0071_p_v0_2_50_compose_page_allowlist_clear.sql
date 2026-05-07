-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.50 — clear compose-page's allowlistedTools.
--
-- Same family of bug as v0.2.48 / migration 0070 (brand-voice-guard).
-- Different skill, different engagement path, same shape: the seeded
-- allowlist excludes tools the skill body invites.
--
-- compose-page engages via keyword on "build / create / page / compose"
-- (see 0032_p10a_skills.sql). Its body says "Lay out the page
-- block-by-block: header → content → footer" — that requires layout
-- tools (`add_module_to_layout`, `set_nav_menu`) when the user asks for
-- site-wide chrome. The seed allowlist enumerates 8 page-only tools,
-- omitting every layout + page-rename + page-delete tool. The runner
-- narrows the AI's catalogue to the union of engaged skills'
-- allowlists; with compose-page as the only narrow contributor, the AI
-- sees 8 tools, plans header-on-layout in text, finds
-- add_module_to_layout missing, and ends the turn cleanly with no
-- tool_use blocks. From the operator's POV: text appears, then silence.
-- Reproduced today after v0.2.48 deployed: prompt "build me a website"
-- → AI replied "Trying it now — building header + footer on the
-- site-default layout, then hero, features, and CTA on the homepage"
-- → no tool calls, no further text, SSE closed cleanly.
--
-- Fix: empty the allowlist. The skill body already focuses the AI on
-- page-composition flow ("Use create_page, add_module_to_page,
-- add_module_to_template..."); restriction was the problem, not the
-- focus. element-chip-editor's [edit_module] allowlist is intentional
-- (body says "Never use add_module_to_page or any structural tool"),
-- so this migration leaves it alone.
--
-- v0.2.48's chat-runner change (skip alwaysOn-only contributions to
-- the narrowing union) doesn't help here — compose-page engages via
-- keyword, not alwaysOn. A broader runner change (skip ALL keyword
-- engagements' allowlists) would regress element-chip-editor's
-- intentional restriction; data fix is the right shape.
--
-- Match conservatively on the exact 8-tool seed value, so any operator
-- who has hand-tuned compose-page via /security/skills is untouched.

UPDATE skills
   SET allowlisted_tools = '[]'::jsonb
 WHERE slug = 'compose-page'
   AND allowlisted_tools = '["create_page","add_module_to_page","add_module_to_template","edit_module","reorder_module","move_module","change_template","duplicate_page"]'::jsonb;
