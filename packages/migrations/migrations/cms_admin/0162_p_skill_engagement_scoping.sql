-- SPDX-License-Identifier: MPL-2.0
--
-- 0162 — scope skill auto-engagement to real intent (footer over-spawn flake).
--
-- Root cause (run-logs/flake-investigation/footer-single-admin.log): the
-- live-AI footer scenario — a trivial "add a footer with navigation links to
-- every page" (one site-wide `add_module_to_layout`) — intermittently ran 8+
-- minutes and timed out. The parent turn engaged ONLY `menu-auditor` (a
-- read-only AUDIT role) because its keywords "menu"/"navigation"/"links"
-- substring-matched the BUILD request. menu-auditor's read-only allowlist then
-- narrowed the parent's write tools to nothing, so the model could no longer
-- author the footer directly and was FORCED to spawn subagents (which get the
-- full catalogue) purely to perform the writes — 4 sequential spawns +
-- redundant re-discovery blew the turn-idle budget. (The catalogue side is
-- fixed structurally in context/skills.ts — a read-only-only allowlist no
-- longer narrows a turn. This migration removes the mis-match at the source.)
--
-- Two engagement bugs, same shape: audit/quality skills fire on generic
-- SUBSTRINGS that appear in ordinary build/edit requests.
--   * menu-auditor: "menu"/"navigation"/"links" match any nav/footer BUILD.
--   * design-quality: "build"/"design"/"layout"/"section"/"style"/"modern"
--     match "build a card", "change the layout", "fix the style", … and its
--     chipTrigger:true dragged the expensive 2-round screenshot self-review
--     loop into EVERY element-chip edit. Design-quality must engage only on
--     genuine design work (redesign / restyle / "make it beautiful"), not on
--     routine module edits.
--
-- The matcher is pure case-insensitive keyword-substring (packages/shared/src/
-- skills.ts) with no score floor beyond > 0, so a single generic keyword is
-- enough to engage. The fix is to make each skill's keywords express INTENT,
-- not incidental vocabulary.

BEGIN;

-- menu-auditor: engage on an explicit AUDIT of the nav/menu, never on building
-- one. "audit" appears in audit requests ("audit my nav menu") but not in build
-- requests ("add a footer with navigation links"); "nav-menu" / "menu-auditor"
-- cover the structured-set kind and the subagent role wording.
UPDATE skills
SET auto_engagement_hints =
  '{"keywords": ["audit", "nav-menu", "menu-auditor"], "chipTrigger": false, "alwaysOn": false}'::jsonb
WHERE slug = 'menu-auditor';

-- design-quality: engage only on real design intent. Drop the generic
-- substrings (build/create page/homepage/landing/hero/modern/design/layout/
-- section/style) that matched routine edits, and turn OFF chipTrigger so a
-- small scoped chip edit no longer forces the screenshot self-review loop.
UPDATE skills
SET auto_engagement_hints = '{"keywords": ["redesign", "restyle", "make it beautiful", "make it pretty", "make it modern", "looks ugly", "looks boring", "looks bland", "looks dated", "looks cheap", "look better", "look nicer", "looks off", "visual hierarchy", "design overhaul", "polish the design", "improve the design", "redesign the"], "chipTrigger": false, "alwaysOn": false}'::jsonb
WHERE slug = 'design-quality';

-- qa-check: drop the bare "check" substring (matches "checkout"/"checklist"/
-- "check the box"); keep the QA-intent terms. Engages on real QA requests and
-- inside QA subagents whose task wording says "QA"/"review".
UPDATE skills
SET auto_engagement_hints =
  '{"keywords": ["qa", "quality", "review", "verdict", "proofread"], "chipTrigger": false, "alwaysOn": false}'::jsonb
WHERE slug = 'qa-check';

COMMIT;
