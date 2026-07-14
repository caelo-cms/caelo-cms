-- SPDX-License-Identifier: MPL-2.0
--
-- 0151 — site-migrate: teach THE REBUILD CONTRACT to import brand assets
-- and honour the measured type scale + source spacing (issue #278 follow-up,
-- epic #252).
--
-- Live-test findings on the #278 flow (0150): the AI rebuilt the site LOGO in
-- HTML/CSS instead of importing the original asset (media_assets=0 for the run),
-- and fonts/spacing drifted (diff_status=fail). Two gaps in the skill body:
--   1. THE REBUILD CONTRACT never mentions the logo/favicon, set_theme_asset, or
--      the {{theme_logo_url}} placeholder — and its "author fresh semantic html"
--      instruction actively nudges the model to REDRAW a logo. A logo is a brand
--      IMAGE, not design to recreate: it must be imported (migrate_media re-hosts
--      a real <img>) or bound as a theme asset, never hand-authored.
--   2. The sampled design tokens carry a real type scale (font sizes/weights/
--      line-heights per role) but the body only said "colors, fonts, layout" —
--      the model eyeballed sizes from the screenshot. Spacing is not a measured
--      token at all, so the body must point the model at the screenshot rhythm.
--
-- Targeted, idempotent amendment (NOT a full-body rewrite): REPLACE the single
-- "sampled design tokens ... ground truth" bullet of THE REBUILD CONTRACT with
-- an expanded bullet + a new BRAND ASSETS bullet. Guarded so a re-run is a no-op
-- and this only fires against the #278 body.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = REPLACE(
  body,
  '   - Use the run''s sampled design tokens and the stored source screenshots as ground truth for colors, fonts, and layout — never guess a palette the crawl already measured.',
  '   - Use the run''s sampled design tokens and the stored source screenshots as ground truth for colors, fonts, and layout — never guess a palette the crawl already measured. The sampled tokens carry the real TYPE SCALE too (font family, size, weight, line-height per role — body, headings, links, buttons): reuse those values, do not eyeball a heading size or weight from the screenshot. SPACING is not a measured token — read the source screenshot for the section rhythm (vertical gaps between sections, padding inside cards and containers) and match it; do not silently tighten or loosen the layout unless IMPROVE-BY-DEFAULT clearly calls for it.
   - BRAND ASSETS ARE IMPORTED, NEVER REDRAWN: the logo and favicon are the operator''s real brand files, not design for you to recreate. NEVER rebuild a logo as HTML/CSS, hand-authored SVG, or a styled text wordmark. Either preserve the source logo as a real <img> in the header so `migrate_media` downloads and re-hosts it, OR bind it once as the theme logo with `set_theme_asset({slot:''logo''})` and reference `{{theme_logo_url}}` in the chrome; do the same for the favicon (`set_theme_asset({slot:''favicon''})` + `{{theme_favicon_url}}`). A rebuilt-from-scratch logo is a migration defect: if the source header carries an <img>/<svg> logo, the Caelo header must point at Caelo-hosted media or the theme asset, never at a redrawn shape. Note that `migrate_media` imports images (and fonts + pdf) but NOT video — if a source page embeds a video, keep the reference and tell the operator video is not auto-migrated rather than dropping it silently.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%FAIL-FAST, HOMEPAGE-FIRST (issue #278)%'
  AND body NOT LIKE '%BRAND ASSETS ARE IMPORTED%';

COMMIT;
