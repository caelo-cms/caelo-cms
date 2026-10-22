-- SPDX-License-Identifier: MPL-2.0
--
-- 0331 — epic #724 rollout G: links on the site follow renames and moves.
--
-- Internal links are stored as page references, so a slug change or a
-- page move no longer rewrites any stored link (the text rewriter and
-- `pages.rewrite_module_links` are gone). The 301 a move creates is for
-- links from outside the site. manage-redirects is the skill engaged on
-- "moved the page" / "old url" / "broken link", so it learns that there
-- is no link-update step after a move, and that a link on the site is
-- fixed by pointing it at the page, not by a redirect.
--
-- Appended with a NOT LIKE guard on a marker sentence (as 0286 / 0289
-- do): idempotent, and an Owner-edited body keeps its own text plus the
-- new section once.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = body || '

LINKS ON THE SITE FOLLOW MOVES:
- Write internal links as the page''s path (`/about`, `/about#team`). Caelo stores each one as a link to the page itself, so nav menus, link lists, module and content links follow a rename (update_pages_many slug) or a move (move_pages) automatically. Do not search for or update links after moving a page.
- The 301 a rename or move creates is for links from OUTSIDE the site (search engines, bookmarks, other sites). A link on the site itself is fixed by pointing it at the page (its current path); that stores a link to the page, which then follows every later move.'
 WHERE slug = 'manage-redirects'
   AND body NOT LIKE '%LINKS ON THE SITE FOLLOW MOVES:%';

COMMIT;
