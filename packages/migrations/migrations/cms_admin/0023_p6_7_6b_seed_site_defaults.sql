-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 6.7.6 follow-up — make site_defaults seeding self-sufficient.
--
-- Background: 0021_p6_7_6_layouts.sql seeded site_defaults conditionally
-- (`WHERE EXISTS (SELECT 1 FROM templates WHERE slug='home-template')`),
-- relying on the dev seed script to insert site_defaults afterwards.
-- That works for dev installs but breaks every CI environment that
-- runs migrations without seed-dev — site_defaults stays empty, and
-- every test that calls templates.create / pages.create without an
-- explicit layoutId / templateId hits the no-fallback resolver in
-- packages/admin-core/src/ops/content/{templates,pages}.ts and fails.
--
-- Fix per CLAUDE.md §2 ("defaults are stored data, not code paths"):
-- the migration owns the bootstrap. If home-template is missing, create
-- a placeholder bound to the site-default layout, then seed
-- site_defaults. Idempotent on every axis — re-runs are no-ops, and
-- the dev seed script's home-template is preserved when it already
-- exists.

------------------------------------------------------------------------
-- 1. Placeholder home-template if missing.
--    Binds to the site-default layout (seeded by 0021). Real installs
--    that already ran seed-dev keep their existing home-template; this
--    is purely a CI / fresh-migrate-only-path bootstrap.
------------------------------------------------------------------------
INSERT INTO templates (slug, display_name, html, css, layout_id)
SELECT
  'home-template',
  'Home (default)',
  '<!doctype html><html><head><title>Home</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
  '',
  (SELECT id FROM layouts WHERE slug = 'site-default')
WHERE NOT EXISTS (SELECT 1 FROM templates WHERE slug = 'home-template')
  AND EXISTS (SELECT 1 FROM layouts WHERE slug = 'site-default');

--> statement-breakpoint

------------------------------------------------------------------------
-- 2. Default `content` block on the placeholder template if missing.
--    Skipped when the row already had blocks (existing seed-dev install).
------------------------------------------------------------------------
INSERT INTO template_blocks (template_id, name, display_name, position)
SELECT
  (SELECT id FROM templates WHERE slug = 'home-template'),
  'content',
  'Content',
  0
WHERE EXISTS (SELECT 1 FROM templates WHERE slug = 'home-template')
  AND NOT EXISTS (
    SELECT 1 FROM template_blocks
    WHERE template_id = (SELECT id FROM templates WHERE slug = 'home-template')
      AND name = 'content'
  );

--> statement-breakpoint

------------------------------------------------------------------------
-- 3. site_defaults singleton if empty.
--    The CHECK (id = 1) guarantees at most one row; this INSERT only
--    fires when no row is present. Existing seed-dev installs that
--    already inserted are left alone.
------------------------------------------------------------------------
-- The id column is GENERATED ALWAYS AS IDENTITY but the singleton
-- CHECK requires id = 1; if the sequence ever advanced past 1 (e.g.
-- a manual DELETE + reinsert sequence on an installed DB) a plain
-- INSERT would fail the CHECK. OVERRIDING SYSTEM VALUE with explicit
-- id = 1 keeps the migration robust on every install path.
INSERT INTO site_defaults (id, default_layout_id, default_template_id)
OVERRIDING SYSTEM VALUE
SELECT
  1,
  (SELECT id FROM layouts WHERE slug = 'site-default'),
  (SELECT id FROM templates WHERE slug = 'home-template')
WHERE NOT EXISTS (SELECT 1 FROM site_defaults)
  AND EXISTS (SELECT 1 FROM layouts WHERE slug = 'site-default')
  AND EXISTS (SELECT 1 FROM templates WHERE slug = 'home-template');
