-- SPDX-License-Identifier: MPL-2.0
--
-- 0185 — seed the `homepage` skill (final of the homepage-model fix set).
--
-- Teaches the site-ROOT model so the AI stops duplicating / mis-slugging the
-- homepage (the searchviu run built it twice + deleted the correct root):
--   * the homepage is the site ROOT, served at `/` — there is no `/home` URL;
--   * exactly ONE page may be the root (the create backstop now enforces this);
--   * a source locale path (`/en/`) is NOT a page slug — it is the URL-strategy
--     plus a `/` -> `/<locale>/` redirect;
--   * the AI authors every page itself — no background composition.
--
-- NOTE (current state): a page serves at `/` via the root slug (`home`/`index`/
-- empty). `set_home_page` records the canonical-homepage designation and the
-- create-backstop treats it as the root, but the static URL output for a
-- NON-root-slug designated page is not threaded yet — so the reliable way to put
-- a page at `/` today is the `home` slug. When resolver-caller threading lands,
-- this skill's point 1 gets updated to lead with set_home_page.
--
-- Seeded ACTIVE like the other core authoring skills (0168). Idempotent.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES (
  'homepage',
  'Homepage & site root',
  'How the site homepage / root works — which page serves at `/`, built exactly once. Engaged when the user asks about the homepage, the site root, or what shows at /.',
  $body$You are setting or fixing the site's HOMEPAGE — the page served at the site ROOT.

1. THE HOMEPAGE IS THE SITE ROOT (`/`), NOT a page at `/home`. A page serves at the root when its slug is `home` (also `index`, or empty) — that slug is a SENTINEL the URL resolver maps to `/` (per locale, the locale root, e.g. `/en/` under a subdirectory URL strategy). Give the root page the `home` slug and it serves at `/`. Use `set_home_page({pageId})` to record which page is the canonical homepage.

2. EXACTLY ONE ROOT. There is one homepage per locale. Creating a second page that resolves to `/` (another `home`/`index`/empty slug, or a second designated home) is now REJECTED with an error naming the existing root — EDIT the existing homepage instead of making another.

3. BUILD IT ONCE — YOU AUTHOR EVERY PAGE. Nothing auto-creates pages; there is no background composition. If a duplicate homepage appears, YOU built it (e.g. under two slugs) — check `list_pages` and your own build_page calls before blaming a tool, and never file a bug about an "automatic" process. Before building the homepage, call `list_pages`; if a home page exists, edit it (`build_page` with its pageId).

4. A SOURCE URL'S LOCALE SEGMENT IS NOT A PAGE SLUG. For `example.com/en/`, the homepage is still the ROOT page (slug `home`), NOT a page with slug `en` (that would be a real page at `/en`). A locale prefix like `/en/` is the LOCALE URL-STRATEGY (admin-gated — `propose_update_locale_strategy`), plus, if the site should live under `/en/`, a redirect `/` -> `/en/` you add with `bulk_create_redirects`. Never encode a locale path as a page slug.

5. MOVING THE HOMEPAGE: renaming a page's slug with `update_pages_many` auto-creates a 301 from the old path, so nothing is left dead. Never leave two pages claiming `/`.$body$,
  '["build_page","update_pages_many","list_pages","set_home_page","bulk_create_redirects"]'::jsonb,
  '{"keywords":["homepage","home page","site root","startseite","front page","root url","home slug","what shows at /","which page is the homepage","set homepage"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
  'active'
)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
