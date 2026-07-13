-- SPDX-License-Identifier: MPL-2.0
--
-- 0138 — site-migrate: wire the WS2 rebuild-quality checks into the
-- REBUILD CONTRACT (issue #248). Two guarded amendments (0107-pattern):
--
--   1. Boilerplate detection BEFORE the rebuild — after clustering, the
--      AI runs detect_import_boilerplate so blocks that recur across
--      pages become ONE shared module at the right level (layout /
--      template / content_instance) instead of copied per page.
--
--   2. The content-inventory check AFTER each rebuild — the AI runs
--      check_page_content_inventory to prove no source content was lost;
--      this is the ENFORCEMENT the "improve while rebuilding" default
--      relies on. Skill text names the tools so the model reaches for
--      them (skills teach behaviour; CLAUDE.md 2).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- Amendment 1 — content-inventory check on the completeness bullet.
UPDATE skills
SET body = replace(
  body,
  '   - CONTENT COMPLETENESS is the hard rule: every heading, paragraph, list item, image, and link from the source page appears in the rebuilt page. Check this before moving on; report anything you deliberately dropped and why.',
  '   - CONTENT COMPLETENESS is the hard rule: every heading, paragraph, list item, image, and link from the source page appears in the rebuilt page. Do not eyeball this — after each rebuild call `check_page_content_inventory` (pass the page id); it lists exactly what is covered and what is missing. Restore anything genuinely dropped, or record why via `add_import_page_notes` — never let content vanish silently.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%CONTENT COMPLETENESS is the hard rule%'
  AND body NOT LIKE '%check_page_content_inventory%';

-- Amendment 2 — boilerplate detection after the chrome bullet.
UPDATE skills
SET body = replace(
  body,
  '   - CHROME IS LAYOUT-OWNED (#253): the imported header/footer are bound to the layout once. Rebuild them ONCE via the layout tools (edit the layout-bound module; navigation becomes a link-list field) — never per page, never inside page bodies.',
  '   - CHROME IS LAYOUT-OWNED (#253): the imported header/footer are bound to the layout once. Rebuild them ONCE via the layout tools (edit the layout-bound module; navigation becomes a link-list field) — never per page, never inside page bodies.
   - REUSE BOILERPLATE, NEVER COPY IT: after clustering and BEFORE rebuilding pages, call `detect_import_boilerplate` for the run. Blocks that recur across pages (CTA banners, newsletter boxes, breadcrumb zones, author bios, in-content nav) are boilerplate, not per-page content. Rebuild each ONCE at the suggested level — site-wide → a layout block, per-page-type → a template block, a fixed block recurring on some pages → a shared synced content_instance, a semi-dynamic zone like breadcrumbs → a template block whose values fill per page — and reference it, rather than copying it into every rebuilt page.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%CHROME IS LAYOUT-OWNED (#253)%'
  AND body NOT LIKE '%detect_import_boilerplate%';

COMMIT;
