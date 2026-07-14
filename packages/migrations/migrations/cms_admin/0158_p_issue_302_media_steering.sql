-- SPDX-License-Identifier: MPL-2.0
--
-- 0158 (issue #302) — site-migrate steering: homepage-at-root + the new
-- migrate_media zero-units telemetry.
--
-- Two targeted, guarded, idempotent amendments to the #278 flow body
-- (0150, as amended by 0151 + 0154):
--
--   1. HOMEPAGE AT ROOT (run #14 finding): the engine serves ONLY the
--      slugs '', 'home' and 'index' at the site root '/' (static
--      generator pageOutputPath + staging preview). The skill never said
--      which slug the homepage must use, so the rebuilt homepage landed
--      on a source-derived slug and '/' 404ed. The engine half of the fix
--      (#302) makes such a build FAIL loudly; this amendment stops the
--      failure from being hit at all.
--
--   2. MIGRATE_MEDIA ZERO-UNITS (run #15 finding): migrate_media now
--      reports rewritable-unit counts per source and returns an explicit
--      "0 media units found" warning instead of an opaque error. Teach the
--      flow to treat that warning as a STOP-and-fix, never as done.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- 1. Homepage slug MUST be 'home' — appended to the STEP-2 homepage bullet.
UPDATE skills
SET body = REPLACE(
  body,
  '   - Build the homepage''s own content modules + its template (name it e.g. ''Startseite''), following THE REBUILD CONTRACT below — fresh semantic module html carrying ALL of the source content.',
  '   - Build the homepage''s own content modules + its template (name it e.g. ''Startseite''), following THE REBUILD CONTRACT below — fresh semantic module html carrying ALL of the source content.
     - THE HOMEPAGE PAGE SLUG MUST BE `home` — Caelo serves ONLY the slugs `home` (or `index`) at the site root `/`; any other slug (a source-derived path like `en` or `startseite`) leaves the bare domain a 404 and the deploy now FAILS loudly on it. Create the homepage with `create_page({slug: ''home''})`; if it already exists under another slug, fix it with `change_page_slug` before finishing.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%FAIL-FAST, HOMEPAGE-FIRST (issue #278)%'
  AND body NOT LIKE '%THE HOMEPAGE PAGE SLUG MUST BE%';

-- 2. migrate_media zero-units is a STOP — appended to MEDIA IS A STATE CHECK.
UPDATE skills
SET body = REPLACE(
  body,
  'Relay every skipped asset (url + reason) to the operator VERBATIM; never claim media migrated when the report says skipped.',
  'Relay every skipped asset (url + reason) to the operator VERBATIM; never claim media migrated when the report says skipped. `migrate_media` reports how many rewritable units it found per source (compose vs direct-build) — if it answers "0 media units found", NOTHING was migrated: read the likely causes in the tool result, fix them (most often: the pages must exist first, and the call must run from the SAME chat that built them — another chat''s unpublished pages are invisible here), then call `migrate_media` again. Never continue past a 0-units result as if media were handled.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%MEDIA IS A STATE CHECK%'
  AND body NOT LIKE '%0 media units found%';

COMMIT;
