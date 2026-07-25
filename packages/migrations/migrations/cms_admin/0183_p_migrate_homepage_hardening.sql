-- SPDX-License-Identifier: MPL-2.0
--
-- 0183 — site-migrate: harden the HOMEPAGE step against the run-observed failure.
--
-- Live run (searchviu.com/en/): the AI built the homepage TWICE — once with
-- slug `home`, once with slug `en` (it hedged the ambiguous root slug, firing
-- both build_page calls in one turn) — then deleted the correct root page
-- believing a phantom "background composition" had created a duplicate, and
-- filed a false bug. Three corrections: (1) the homepage is the site ROOT,
-- built ONCE at the root/home slug; (2) a source URL's locale segment (`/en/`)
-- is NOT a page slug — it is the URL-strategy + a redirect; (3) the AI authors
-- every page itself, there is no background composition, so a duplicate means
-- it built twice. Surgical replace() on the #278 step-2 header, idempotent.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(
  body,
  $anchor$2. HOMEPAGE FIRST — build the HOMEPAGE, and ONLY the homepage, as the design anchor: template AND content together, fully rendered and visible. This is where the design gets decided; nothing else is built until the operator has aligned it (step 3).$anchor$,
  $new$2. HOMEPAGE FIRST — build the HOMEPAGE, and ONLY the homepage, as the design anchor: template AND content together, fully rendered and visible. This is where the design gets decided; nothing else is built until the operator has aligned it (step 3).
   - CANONICAL ROOT, BUILT ONCE. The homepage is the site ROOT: build it as ONE page with the root/home slug (it serves at `/` — per locale, the locale root). Do NOT turn the source URL's locale segment into a page slug — `example.com/en/` means the homepage is still the ROOT page, NOT a page with slug `en` (that would be a real page at `/en`). A locale prefix is the URL-strategy (admin-gated) plus a `/` → `/<locale>/` redirect, NEVER a slug. Never hedge by building the homepage under two slugs.
   - YOU AUTHOR EVERY PAGE — THERE IS NO BACKGROUND COMPOSITION. Nothing auto-creates pages from the crawl. If a second homepage (or any duplicate) appears, YOU built it — check your own build_page calls before concluding a tool did it, and NEVER file a bug blaming an "automatic" process. Build the homepage exactly once; if a home page already exists (check with list_pages), EDIT it (build_page with its pageId) instead of creating another.$new$
)
WHERE slug = 'site-migrate'
  AND body NOT LIKE '%CANONICAL ROOT, BUILT ONCE%';

COMMIT;
