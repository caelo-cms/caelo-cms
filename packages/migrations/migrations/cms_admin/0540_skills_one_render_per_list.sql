-- SPDX-License-Identifier: MPL-2.0
--
-- 0540 — epic #1371: the manage-menu skill teaches one render per list
-- and a lean frame.
--
-- A migrated site carried every menu link two to three times per page: a
-- header that wrote its mega menu once for desktop and once for mobile,
-- and a footer bound to the same shared list. The skill's own example for
-- promoting a local list was "show the footer links in the mobile menu
-- too", and its mobile-menu sentence did not say the kit collapses the
-- SAME markup. The structure check now reports both shapes
-- (`structure/repeated-render`, `structure/heavy-chrome`); this corrects
-- what the skill teaches so the AI builds it right the first time.
--
-- replace() of the exact seeded passages (0356), guarded on the passage:
-- idempotent, and an Owner-edited body without the passage stays as the
-- Owner wrote it. Plugin-owned skills are not touched.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(
  body,
  $old$For a collapsing mobile menu use the interaction kit's `mobile-nav` markup.$old$,
  $new$ONE list, ONE render: the same `<nav>` serves every width. For a collapsing mobile menu put the interaction kit's `mobile-nav` markup on that nav; never write a second `{{#menu}}` loop or a separate mobile-menu module, because each copy puts every link into every page again (Stage blocks it: structure/repeated-render). The frame (header, footer, banners) is paid on every page, so keep it lean: no wrapper elements without a style of their own, icons as `<img>` files rather than repeated inline SVG (Stage reports a frame from 250 elements and blocks it from 400: structure/heavy-chrome).$new$
)
WHERE slug = 'manage-menu'
  AND plugin_id IS NULL
  AND body LIKE $like$%For a collapsing mobile menu use the interaction kit's `mobile-nav` markup.%$like$;

UPDATE skills
SET body = replace(
  body,
  $old$When a local list turns out to be needed elsewhere ("show the footer links in the mobile menu too"),$old$,
  $new$A footer does not repeat the whole main menu: it binds its own short shared list (legal pages, contact, the top sections). When a local list turns out to be needed by another module ("the sidebar shows these links too"),$new$
)
WHERE slug = 'manage-menu'
  AND plugin_id IS NULL
  AND body LIKE $like$%When a local list turns out to be needed elsewhere ("show the footer links in the mobile menu too"),%$like$;

COMMIT;
