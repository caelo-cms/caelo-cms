-- SPDX-License-Identifier: MPL-2.0
--
-- 0334 — issues #158 / #160 (design-quality epic #149): the
-- design-quality skill learns the two page-wide-bundle rules.
--
-- Every module's CSS joins one stylesheet per page, so unscoped
-- selectors restyle other modules (#158; the authoring tools now flag
-- them in their result). Accordions, tabs and carousels ship as a
-- vetted, accessible interaction kit selected by `data-caelo-ui` (#160),
-- so the skill steers the AI away from hand-written JS for them.
--
-- Appended with a NOT LIKE guard on the section marker (as 0198 / 0331
-- do): idempotent, and an Owner-edited body keeps its own text plus the
-- new section once.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = body || '

PAGE-WIDE CSS AND INTERACTIONS:
- Every module''s CSS lands in ONE stylesheet per page. Give each module''s root element a class and nest all of its selectors under it (`.pricing h2`, `.pricing__card`), never `h2`, `body`, `a` or a generic `.card` on its own: those restyle every other module on the page. The authoring tools flag unscoped selectors in their result; fix them in the same turn.
- Accordions (FAQ), tabs and carousels need no module JS: mark the markup with `data-caelo-ui="accordion"`, `"tabs"` or `"carousel"` following the markup contract in the module tools'' `js` description, and Caelo ships keyboard- and screen-reader-accessible behaviour once per page. Style them freely in the module CSS. Write module JS only for behaviour the kit does not cover.'
 WHERE slug = 'design-quality'
   AND body NOT LIKE '%PAGE-WIDE CSS AND INTERACTIONS:%';

COMMIT;
