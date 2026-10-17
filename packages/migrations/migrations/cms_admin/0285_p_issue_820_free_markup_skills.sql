-- SPDX-License-Identifier: MPL-2.0
--
-- 0285 — issue #820: free HTML versus modules.
--
-- Page builds kept pasting component markup (a step chain, paired columns,
-- a comparison table) into richtext values of a generic text module, page
-- after page, with the pattern's CSS in the layout. The core `structure`
-- quality check now blocks clearly repeated free markup and the write
-- tools hint at the second copy; these skills say the rule up front so the
-- first build already gets it right:
--
--   - manage-module + compose-page: richtext is prose; a component pattern
--     is a module; one-off free markup on one page is fine, the second copy
--     becomes a module; module CSS never goes into the layout.
--   - fix-quality-findings: how to fix the `structure/*` findings.
--
-- Appended with a NOT LIKE guard on a marker sentence (as 0168 does for
-- compose-page): idempotent, and an Owner-edited body keeps its own text
-- plus the new section once.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = body || '

FREE HTML VERSUS MODULES (the structure rule):
- Richtext and text values are PROSE: paragraphs, headings, inline emphasis, links, simple lists. A component pattern — a step chain, paired columns, a timeline, a checklist with icons, a comparison table, cards — is a MODULE with fields, never markup pasted into a field value.
- One-off free markup on a single page is allowed. The moment a pattern appears a SECOND time (on another page, or as a copy of a module that already exists), make it a module: mint ONE module from the markup with semantic fields (text-list / link-list / module-list for the repeating items), place it wherever the copies are with their own values, and remove the free copies. A module that already renders the pattern is placed by moduleId, never copied.
- A module''s CSS lives in that module. Never put a pattern''s or a single module''s styles into the layout CSS: layout CSS ships on every page, module CSS only where the module is placed.
- The write tools tell you when markup repeats ("markup-guard" / "design-guard" in the result) — act on it in the same turn. Repeated free markup blocks Publish live in the structure quality check.'
 WHERE slug IN ('manage-module', 'compose-page')
   AND body NOT LIKE '%FREE HTML VERSUS MODULES (the structure rule):%';

UPDATE skills
   SET body = body || '

STRUCTURE FINDINGS (`structure/*` rule ids):
- `structure/repeated-markup` / `structure/similar-markup`: the same pattern sits as free HTML on several pages, or copies an existing module. The finding lists the pattern (e.g. `div.chain`), the module whose fields carry it and every page it is on. If it names an existing module, place that module by moduleId with each page''s values; otherwise mint ONE module from the markup (semantic fields, list fields for the repeating items) and place it on every listed page in one bulk pass. Then remove the free copies from the field values and move the pattern''s CSS from the layout into the module.
- `structure/duplicate-module`: two modules share one structure. Keep one (move differing hardcoded text into fields), place it wherever the others are placed with their content as values, delete the copies.
- `structure/layout-css-module-specific`: move the named rules from the layout CSS into the module that uses them.'
 WHERE slug = 'fix-quality-findings'
   AND body NOT LIKE '%STRUCTURE FINDINGS (`structure/*` rule ids):%';

COMMIT;
