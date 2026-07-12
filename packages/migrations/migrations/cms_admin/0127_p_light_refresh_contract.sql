-- SPDX-License-Identifier: MPL-2.0
--
-- 0127 — site-migrate: the LIGHT REFRESH route gets a contract.
-- Live-hit (mission run #3): after compose_from_run built 28 pages,
-- the AI "applied the light refresh" by clearing the imported
-- homepage body and hand-building replacement modules from memory —
-- it got tangled in placement mechanics and left the homepage blank.
-- Light refresh means: composed pages ARE the site; refresh through
-- theme tokens + chrome only; body content is the operator's real
-- content and stays.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(
  body,
  '6. AFTER THE CRAWL (status ready_for_review) — route by the operator''s step-3 answer:
   - KEEP DESIGN: the crawled homepage is the design contract. `compose_from_import` builds the staged draft site from the crawl; then verify the homepage against the original (screenshot both, compare honestly) and fix what drifted before presenting.
   - REDESIGN: hand off to Site Genesis (the site-genesis skill) with one crucial difference — the crawled pages are the CONTENT brief. The operator''s real copy, page inventory, and structure come from the crawl; only the design diverges.',
  '6. AFTER THE CRAWL (status ready_for_review) — route by the operator''s step-3 answer:
   - KEEP DESIGN (A): the crawled homepage is the design contract. `compose_from_import` builds the staged draft site from the crawl; then verify the homepage against the original (screenshot both, compare honestly) and fix what drifted before presenting.
   - LIGHT REFRESH (B): `compose_from_import` output IS the site — the imported page bodies carry the operator''s REAL content and stay untouched. Apply the refresh ONLY through theme tokens (`set_theme_tokens`: typography, spacing, radius, shadows, palette polish) and, where the original chrome is poor, new site-wide header/footer modules on the layout. NEVER clear, blank, or hand-rebuild an imported page body from memory — body-level modernisation is Site Growth work, done page-by-page AFTER the operator has seen the migrated site. Then verify the homepage renders (screenshot) and present.
   - FULL REDESIGN (C): hand off to Site Genesis (the site-genesis skill) with one crucial difference — the crawled pages are the CONTENT brief. The operator''s real copy, page inventory, and structure come from the crawl; only the design diverges.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%6. AFTER THE CRAWL%'
  AND body NOT LIKE '%LIGHT REFRESH (B)%';

COMMIT;
