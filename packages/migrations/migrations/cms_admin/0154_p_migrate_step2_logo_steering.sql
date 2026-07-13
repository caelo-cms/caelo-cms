-- SPDX-License-Identifier: MPL-2.0
--
-- 0154 — site-migrate: surface the "import the logo, never redraw it"
-- instruction AT the chrome-building step (workflow STEP 2), not only
-- inside THE REBUILD CONTRACT (issue #278 follow-up, epic #252).
--
-- Root cause of the searchviu live-run redraw (media_assets=0, a
-- hand-authored `<a class="sv-header__logo">search<span>VIU</span></a>`
-- wordmark): the real source logo is a genuine PNG <img>
-- (…/searchviu-logo2x-300x300.png, alt="searchVIU") — perfectly
-- importable — but the ONLY logo instruction lived in THE REBUILD
-- CONTRACT under STEP 4 (fan-out). The header is built in STEP 2 ("Build
-- the CHROME ONCE on the LAYOUT"), several hundred tokens BEFORE the
-- contract, whose nearest guidance was just "header and footer are
-- layout-owned modules … Navigation becomes a link-list field" — nothing
-- about the logo being a real brand asset. The model authored the header
-- at exactly the step that never mentioned the logo. 0151 hardened the
-- contract; this puts the same rule where the header is actually built.
--
-- Targeted, idempotent amendment: REPLACE the single STEP-2 chrome bullet
-- of the #278 body with the same bullet + an explicit logo clause.
-- Guarded so a re-run is a no-op and this only fires against the #278
-- flow body that still carries the un-amended chrome bullet.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = REPLACE(
  body,
  '   - Build the CHROME ONCE on the LAYOUT (#253): the header and footer are layout-owned modules, bound to the layout a SINGLE time and edited via the layout tools — never per page, never inside a page body. Navigation becomes a link-list field.',
  '   - Build the CHROME ONCE on the LAYOUT (#253): the header and footer are layout-owned modules, bound to the layout a SINGLE time and edited via the layout tools — never per page, never inside a page body. Navigation becomes a link-list field.
     - THE HEADER LOGO IS THE OPERATOR''S REAL BRAND FILE — IMPORT IT, NEVER REDRAW IT. The altTexts/markup facets already gave you the source logo''s <img> src (or inline <svg>); a logo is a brand IMAGE, not design for you to recreate. Put the real logo in the header ONE of two ways: (a) keep the source logo as a real <img> in the header html so `migrate_media` downloads and re-hosts it to Caelo media, OR (b) bind it once with `set_theme_asset({slot:''logo''})` and reference `{{theme_logo_url}}` in the header (do the favicon the same way: `set_theme_asset({slot:''favicon''})`). NEVER hand-author the logo as a text/CSS wordmark or an HTML/CSS/SVG shape — a redrawn logo is a migration defect, and `migrate_media` now flags a header that carries no Caelo-hosted logo <img>, no `{{theme_logo_url}}`, and no bound theme logo asset while the source header had a real logo image. The ONLY time a text logo is acceptable is when the source brand itself is genuinely styled text with no logo image at all.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%FAIL-FAST, HOMEPAGE-FIRST (issue #278)%'
  AND body LIKE '%Build the CHROME ONCE on the LAYOUT (#253):%'
  AND body NOT LIKE '%THE HEADER LOGO IS THE OPERATOR%';

COMMIT;
