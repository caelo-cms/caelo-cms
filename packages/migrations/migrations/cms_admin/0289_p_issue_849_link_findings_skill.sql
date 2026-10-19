-- SPDX-License-Identifier: MPL-2.0
--
-- 0289 — issue #849: the core `links` quality check.
--
-- Every Stage now resolves each same-site URL of the staged build (links,
-- images, stylesheets, scripts, canonical / hreflang) against the build's
-- pages, the redirect table and the build's files. fix-quality-findings
-- learns what each `links/*` rule means and where the fix goes, so the AI
-- fixes the findings instead of reporting them.
--
-- Appended with a NOT LIKE guard on a marker sentence (as 0286 does):
-- idempotent, and an Owner-edited body keeps its own text plus the new
-- section once.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = body || '

LINK FINDINGS (`links/*` rule ids):
- Each finding names the page, the attribute and URL (e.g. `a[href] "/pricng"`), and WHERE the URL is stored: a content value of a module on that page, a module''s template, a navigation menu''s structured set (`nav-menu/<slug>`), a layout, or the page template. The `fix` names the tool for that place — use it; a module template or menu fix repairs every page at once.
- `links/broken-internal` (error): nothing on the staged build answers that URL. Point it at the right existing page (list_pages). If the target is a draft, publish it (set_pages_status_many); if the page moved, keep the URL and add a redirect (bulk_create_redirects) — both also repair links from outside the site.
- `links/broken-asset` (error): the image, stylesheet, script or file does not exist in the build. Point it at a file that exists (find_media for media); for an unbound theme asset (`{{theme_…}}`) bind it with set_theme_asset.
- `links/redirect-loop` (error): the redirect table cycles. Upsert one row of the cycle so it ends at a live page (or delete it), then link that page directly.
- `links/redirect-chain` (warning): the URL works only through redirects. Replace it with the final URL the finding names.
- `links/orphan-page` (warning): no other page links to this one. Add it to a navigation menu or link it from a related page; leave it only when it is meant to stay unlinked (an ad landing page).
- Never fix a link by editing text that merely looks like a path: only real links and file references are checked.'
 WHERE slug = 'fix-quality-findings'
   AND body NOT LIKE '%LINK FINDINGS (`links/*` rule ids):%';

COMMIT;
