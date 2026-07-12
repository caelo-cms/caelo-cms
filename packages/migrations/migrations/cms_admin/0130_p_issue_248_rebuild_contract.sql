-- SPDX-License-Identifier: MPL-2.0
--
-- 0130 — site-migrate: the REBUILD contract replaces the body-freeze
-- (issue #248, WS2 of the migration-fidelity epic #252).
--
-- 0127 froze imported page bodies ("NEVER clear, blank, or
-- hand-rebuild") to stop content loss (F6) — but it over-corrected:
-- it cemented the crawled legacy markup (Elementor div soup that is
-- naked without its never-captured CSS) into every page, forbidding
-- the AI exactly the rebuild it is good at. Operator ruling
-- (2026-07-12): content is sacred, markup is NOT; there was never a
-- 1:1 mandate — improving broken tables / ugly bullets while
-- rebuilding is the DEFAULT, exact-look preservation only on explicit
-- request. Chrome is layout-owned since #253/#254 and is edited via
-- layout tools, never per page.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(
  body,
  '6. AFTER THE CRAWL (status ready_for_review) — route by the operator''s step-3 answer:
   - KEEP DESIGN (A): the crawled homepage is the design contract. `compose_from_import` builds the staged draft site from the crawl; then verify the homepage against the original (screenshot both, compare honestly) and fix what drifted before presenting.
   - LIGHT REFRESH (B): `compose_from_import` output IS the site — the imported page bodies carry the operator''s REAL content and stay untouched. Apply the refresh ONLY through theme tokens (`set_theme_tokens`: typography, spacing, radius, shadows, palette polish) and, where the original chrome is poor, new site-wide header/footer modules on the layout. NEVER clear, blank, or hand-rebuild an imported page body from memory — body-level modernisation is Site Growth work, done page-by-page AFTER the operator has seen the migrated site. Then verify the homepage renders (screenshot) and present.
   - FULL REDESIGN (C): hand off to Site Genesis (the site-genesis skill) with one crucial difference — the crawled pages are the CONTENT brief. The operator''s real copy, page inventory, and structure come from the crawl; only the design diverges.',
  '6. AFTER THE CRAWL (status ready_for_review) — route by the operator''s step-3 answer. For A and B the working unit is the CLUSTER: rebuild ONE representative page per cluster as clean Caelo modules, verify it (screenshot vs the stored source screenshot), then apply the same module pattern to the cluster''s remaining pages with each page''s own content.

   THE REBUILD CONTRACT (A and B):
   - The imported module html is your CONTENT SOURCE — the operator''s real copy lives there. The markup around it is legacy (page-builder div soup without its CSS) and is NOT worth preserving. Author fresh, semantic module html with proper fields (lists as list fields, CTAs as link fields) that carries ALL of the source content.
   - Rebuild = REPLACE IN ONE STEP: author the complete clean replacement, then swap it in. Never clear a page first and rebuild into the emptiness; a page must never be presented blank or with missing content.
   - CONTENT COMPLETENESS is the hard rule: every heading, paragraph, list item, image, and link from the source page appears in the rebuilt page. Check this before moving on; report anything you deliberately dropped and why.
   - IMPROVE BY DEFAULT: fix broken tables, ugly bullet lists, awkward spacing, dated patterns while you rebuild. The result must have better markup and read better than the source. Preserve the exact original look ONLY when the operator explicitly asked for 1:1.
   - CHROME IS LAYOUT-OWNED (#253): the imported header/footer are bound to the layout once. Rebuild them ONCE via the layout tools (edit the layout-bound module; navigation becomes a link-list field) — never per page, never inside page bodies.
   - Use the run''s sampled design tokens and stored source screenshots as ground truth for colors, fonts, and layout decisions — never guess a palette the crawl already measured.

   - KEEP DESIGN (A): the rebuilt pages must MATCH the original''s look — same visual structure, colors, typography (from the sampled tokens), imagery. Verify each representative rebuild against the source screenshot and fix what drifted before presenting.
   - LIGHT REFRESH (B): the rebuilt pages keep the operator''s content complete but get a modern, clean presentation informed by (not chained to) the original. Theme tokens (`set_theme_tokens`) carry the global feel; the per-cluster rebuild carries the structure.
   - FULL REDESIGN (C): hand off to Site Genesis (the site-genesis skill) with one crucial difference — the crawled pages are the CONTENT brief. The operator''s real copy, page inventory, and structure come from the crawl; only the design diverges.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%NEVER clear, blank, or hand-rebuild%'
  AND body NOT LIKE '%THE REBUILD CONTRACT%';

COMMIT;
