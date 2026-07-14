-- SPDX-License-Identifier: MPL-2.0
--
-- 0157 — issue #301: normalize the seeded subagent reviewer skills'
-- allowlists from Query-API op notation to AI tool names.
--
-- Migration 0033 (P10.5) seeded qa-check / legal-check / menu-auditor /
-- page-categorizer with `allowlisted_tools` in op notation
-- (`pages.get_with_modules`, `structured_sets.list`, …). The chat-runner
-- matches AI tool names (`inspect_page_render`, `list_structured_sets`,
-- …), so the intersection was always empty and the zero-match branch
-- silently shipped the FULL tool catalogue on every turn these skills
-- engaged — run #15 logged `skill-allowlist-zero-match` 5× in one
-- session (double damage: tokens + the reviewer subagents kept their
-- write tools despite "You may NOT call any write tools").
--
-- Translation (mirrors OP_NAME_TO_TOOL_NAMES in
-- packages/admin-core/src/ai/chat-runner/allowlist-mapping.ts):
--   pages.get_with_modules → inspect_page_render
--   pages.get / pages.list → list_pages
--   structured_sets.list   → list_structured_sets
--   structured_sets.get    → get_structured_set
--   redirects.lookup/list  → find_redirects
--   glossary.list, style_guide.get, ai_memory.list → dropped (context-
--   served reads: the glossary / style-guide / site-memory data is
--   injected via system-prompt blocks, there is no AI tool to allow).
--
-- Guards: exact-match on the 0033-seeded arrays (0070/0071 pattern) so
-- re-runs are no-ops and operator-edited rows are left alone — those
-- are covered at runtime by the translation layer and at save time by
-- the skills.set/propose validation shipped with this change.

UPDATE skills
   SET allowlisted_tools = '["inspect_page_render","list_pages","get_structured_set","list_structured_sets"]'::jsonb,
       updated_at = now()
 WHERE slug = 'qa-check'
   AND allowlisted_tools = '["pages.get_with_modules","pages.get","pages.list","glossary.list","style_guide.get","ai_memory.list","structured_sets.get","structured_sets.list"]'::jsonb;

UPDATE skills
   SET allowlisted_tools = '["inspect_page_render","list_pages"]'::jsonb,
       updated_at = now()
 WHERE slug = 'legal-check'
   AND allowlisted_tools = '["pages.get_with_modules","pages.get","pages.list","glossary.list"]'::jsonb;

UPDATE skills
   SET allowlisted_tools = '["list_structured_sets","get_structured_set","find_redirects","list_pages"]'::jsonb,
       updated_at = now()
 WHERE slug = 'menu-auditor'
   AND allowlisted_tools = '["structured_sets.list","structured_sets.get","redirects.lookup","redirects.list","pages.list"]'::jsonb;

UPDATE skills
   SET allowlisted_tools = '["list_pages"]'::jsonb,
       updated_at = now()
 WHERE slug = 'page-categorizer'
   AND allowlisted_tools = '["pages.list","pages.get"]'::jsonb;

-- The 0033 skill BODIES instruct the AI to call the same op names
-- ("Read the page via `pages.get_with_modules`") — the same defect
-- class at the instruction layer: the AI emits a tool call no tool
-- answers, burning an error round-trip (epic #307 W4). REPLACE is
-- naturally idempotent; slug-scoped so no other skill's wording moves.

UPDATE skills
   SET body = replace(body, 'pages.get_with_modules', 'inspect_page_render'),
       updated_at = now()
 WHERE slug IN ('qa-check', 'legal-check')
   AND body LIKE '%pages.get_with_modules%';

UPDATE skills
   SET body = replace(replace(replace(body,
                'structured_sets.list', 'list_structured_sets'),
                'redirects.lookup', 'find_redirects'),
                'pages.list', 'list_pages'),
       updated_at = now()
 WHERE slug = 'menu-auditor'
   AND (body LIKE '%structured_sets.list%' OR body LIKE '%redirects.lookup%' OR body LIKE '%pages.list%');

UPDATE skills
   SET body = replace(body, 'pages.list', 'list_pages'),
       updated_at = now()
 WHERE slug = 'page-categorizer'
   AND body LIKE '%pages.list%';
