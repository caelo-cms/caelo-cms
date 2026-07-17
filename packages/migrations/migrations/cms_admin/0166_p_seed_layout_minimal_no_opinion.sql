-- SPDX-License-Identifier: MPL-2.0
--
-- 0166 — the seed layout ships NO visual opinion (white-band root cause).
--
-- The seed `site-default` layout carried opinionated wrapper CSS:
--   .caelo-layout-header,.caelo-layout-footer{padding:1rem 2rem;background:…}
--   .caelo-layout-main{padding:2rem 0}
-- The `.caelo-layout-main` rule is 2rem of vertical padding over an UNSET
-- surface. On a light theme it's invisible (white on white); the moment
-- the AI composes a dark theme, that padding sits between the dark header
-- and the dark hero and shows the body's white backdrop — the recurring
-- "white band" (live-edit runs A4/B5). It's a half-decision: a spacing
-- opinion with no matching surface.
--
-- The real fix isn't "add a background" (that's MORE opinion) — it's to
-- stop the seed prescribing appearance at all. A page has no CSS; a layout
-- is the chrome shell. How the site LOOKS — where the header sits, whether
-- there's a footer, its spacing and colour — is the AI's to compose, and
-- modern module authoring is full-bleed <section> modules that own their
-- own background + padding edge-to-edge. The wrapper should impose nothing.
--
-- So: empty the seed layout's CSS. The `.caelo-layout-*` classes stay as
-- HTML hooks (screenshot selectors etc.); the `body{margin:0}` reset comes
-- from base-css.ts at render, not the layout, so nothing regresses. The AI
-- clothes the chrome; the seed only provides the slot skeleton.
--
-- Match on the exact seed CSS (like 0104) so this touches ONLY the
-- untouched seed + verbatim clones, never a layout the AI/operator edited.

UPDATE layouts
SET css = ''
WHERE css = '.caelo-layout-header,.caelo-layout-footer{padding:1rem 2rem;background:var(--color-background);color:var(--color-foreground)}.caelo-layout-main{padding:2rem 0}';
