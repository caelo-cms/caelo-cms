-- SPDX-License-Identifier: MPL-2.0
--
-- 0117 — compose v2 storage (issue #195, epic #186).
--
-- page_css          — the crawled page's <style> contents. Pre-#195
--                     the pipeline kept only :root custom properties
--                     and threw the stylesheet away — imported pages
--                     rendered unstyled. Compose attaches the cluster
--                     sample's css to the cluster template.
-- design_inventory  — genesis-inventory fact base over the homepage
--                     (colors with usage counts, gradients, shadows,
--                     fonts). Facts are code-computed; the AI reads
--                     this to make its theme decisions ("AI decides,
--                     code executes" — the inventory is the evidence).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_pages ADD COLUMN page_css text NULL;
ALTER TABLE import_runs ADD COLUMN design_inventory text NULL;

-- site-migrate skill: keep-design verification loop + manifest write
-- (guarded amendment, 0107-pattern).
UPDATE skills
SET body = body || '

KEEP-DESIGN VERIFICATION (after compose_from_import builds the staged site): compare honestly — `get_import_page_screenshot({importPageId, which: "source"})` vs `which: "staged"` for the homepage and one page per confirmed type, and read each page''s stored diff status. Fix what drifted (palette, typography, spacing — the run''s design inventory lists the original''s facts) and re-check, at most TWO repair rounds; then report what still differs instead of looping. Finish by writing the Design Manifest (`set_design_manifest`) with the token roles and one pattern entry per confirmed page type — that is what keeps every future page on the migrated design''s line.'
WHERE slug = 'site-migrate'
  AND body NOT LIKE '%KEEP-DESIGN VERIFICATION%';

COMMIT;
