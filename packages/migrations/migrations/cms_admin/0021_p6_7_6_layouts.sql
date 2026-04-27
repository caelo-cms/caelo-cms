-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 6.7.6 — layouts (site-wide chrome) + multi-layout support +
-- site_defaults (NO fallbacks at render time per CLAUDE.md §2).
--
-- Architecture:
--
--   layouts (the site shell — header / content / footer blocks)
--     ↑ templates.layout_id (NOT NULL — every template binds to one layout)
--   templates (the page-type structure — fills the layout's `content` slot)
--     ↑ pages.template_id (NOT NULL, existing)
--   pages
--     ↓ page_modules (per-page module attachments to template blocks)
--     ↓ layout_modules (per-LAYOUT module attachments — header / footer / nav)
--
-- The composer is two-pass: render template into innerHtml, then render
-- the layout substituting innerHtml into <caelo-slot name="content">.
-- Layout modules fill the layout's other blocks (header / footer).
--
-- Defaults are stored data, not code paths: `site_defaults` is a
-- singleton table with NOT NULL FKs to a real layout + template. The
-- pages.create / templates.create resolvers consult it when the caller
-- doesn't specify; the renderer NEVER substitutes — it errors loudly if
-- expected data is missing (per the no-fallbacks invariant).

------------------------------------------------------------------------
-- layouts
------------------------------------------------------------------------
CREATE TABLE layouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  display_name text NOT NULL,
  html         text NOT NULL,
  css          text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz NULL
);

ALTER TABLE layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE layouts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS layouts_authenticated_scope ON layouts;
CREATE POLICY layouts_authenticated_scope ON layouts
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

------------------------------------------------------------------------
-- layout_blocks (named slots inside a layout — header / content / footer)
------------------------------------------------------------------------
CREATE TABLE layout_blocks (
  layout_id    uuid NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  name         text NOT NULL,
  display_name text NOT NULL,
  position     int  NOT NULL,
  PRIMARY KEY (layout_id, name)
);

ALTER TABLE layout_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE layout_blocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS layout_blocks_authenticated_scope ON layout_blocks;
CREATE POLICY layout_blocks_authenticated_scope ON layout_blocks
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

------------------------------------------------------------------------
-- layout_modules (modules attached to layout blocks — header/footer chrome)
------------------------------------------------------------------------
CREATE TABLE layout_modules (
  layout_id    uuid NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  block_name   text NOT NULL,
  position     int  NOT NULL,
  module_id    uuid NOT NULL REFERENCES modules(id),
  PRIMARY KEY (layout_id, block_name, position)
);

ALTER TABLE layout_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE layout_modules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS layout_modules_authenticated_scope ON layout_modules;
CREATE POLICY layout_modules_authenticated_scope ON layout_modules
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

------------------------------------------------------------------------
-- Seed three layouts: site-default, bare, centered.
--
-- Naming convention for the inner content slot: `content`. Layout
-- builders should always include it; the seed asserts it via the block
-- inserts below.
------------------------------------------------------------------------
INSERT INTO layouts (slug, display_name, html, css) VALUES
  (
    'site-default',
    'Site default (header + content + footer)',
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><header class="caelo-layout-header"><caelo-slot name="header">_</caelo-slot></header><main class="caelo-layout-main"><caelo-slot name="content">_</caelo-slot></main><footer class="caelo-layout-footer"><caelo-slot name="footer">_</caelo-slot></footer></body></html>',
    '.caelo-layout-header,.caelo-layout-footer{padding:1rem 2rem;background:var(--color-bg,#fff);color:var(--color-fg,#0f172a)}.caelo-layout-main{padding:2rem 0}'
  ),
  (
    'bare',
    'Bare (no chrome)',
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    ''
  ),
  (
    'centered',
    'Centered article',
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><header class="caelo-layout-header"><caelo-slot name="header">_</caelo-slot></header><main class="caelo-layout-main caelo-centered"><caelo-slot name="content">_</caelo-slot></main><footer class="caelo-layout-footer"><caelo-slot name="footer">_</caelo-slot></footer></body></html>',
    '.caelo-layout-header,.caelo-layout-footer{padding:1rem 2rem}.caelo-centered{max-width:42rem;margin:0 auto;padding:2rem 1rem}'
  );

INSERT INTO layout_blocks (layout_id, name, display_name, position)
SELECT id, 'header', 'Header', 0 FROM layouts WHERE slug = 'site-default'
UNION ALL SELECT id, 'content', 'Content', 1 FROM layouts WHERE slug = 'site-default'
UNION ALL SELECT id, 'footer', 'Footer', 2 FROM layouts WHERE slug = 'site-default'
UNION ALL SELECT id, 'content', 'Content', 0 FROM layouts WHERE slug = 'bare'
UNION ALL SELECT id, 'header', 'Header', 0 FROM layouts WHERE slug = 'centered'
UNION ALL SELECT id, 'content', 'Content', 1 FROM layouts WHERE slug = 'centered'
UNION ALL SELECT id, 'footer', 'Footer', 2 FROM layouts WHERE slug = 'centered';

------------------------------------------------------------------------
-- templates.layout_id — every template binds to a layout. NOT NULL via
-- a backfill: existing rows get site-default, then we flip the column.
-- Legacy templates' HTML may still carry <html><head><body>; the
-- composer is tolerant (browsers parse nested body tags), and editors
-- can rewrite legacy template HTML to drop the shell over time.
------------------------------------------------------------------------
ALTER TABLE templates ADD COLUMN layout_id uuid REFERENCES layouts(id);
UPDATE templates SET layout_id = (SELECT id FROM layouts WHERE slug = 'site-default')
  WHERE layout_id IS NULL;
ALTER TABLE templates ALTER COLUMN layout_id SET NOT NULL;

------------------------------------------------------------------------
-- site_defaults (singleton). Owner-only writes; pages.create + templates.create
-- consult it when the caller doesn't specify a layout / template id.
------------------------------------------------------------------------
CREATE TABLE site_defaults (
  id                  int  PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  default_layout_id   uuid NOT NULL REFERENCES layouts(id),
  default_template_id uuid NOT NULL REFERENCES templates(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES actors(id),
  CONSTRAINT site_defaults_singleton CHECK (id = 1)
);

ALTER TABLE site_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_defaults FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_defaults_authenticated_scope ON site_defaults;
CREATE POLICY site_defaults_authenticated_scope ON site_defaults
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

INSERT INTO site_defaults (default_layout_id, default_template_id)
SELECT
  (SELECT id FROM layouts WHERE slug = 'site-default'),
  (SELECT id FROM templates WHERE slug = 'home-template' LIMIT 1)
WHERE EXISTS (SELECT 1 FROM templates WHERE slug = 'home-template');
-- If home-template doesn't exist yet (fresh DB before seed-dev runs),
-- seed-dev will INSERT site_defaults itself once it creates home-template.

------------------------------------------------------------------------
-- Extend the op_kind CHECK constraint with 'layout_modules.set' so the
-- snapshot emitted by setLayoutModulesOp persists. Postgres has no
-- ALTER CHECK syntax — drop + recreate.
------------------------------------------------------------------------
ALTER TABLE site_snapshots DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
  'modules.create',
  'modules.update',
  'modules.delete',
  'templates.create',
  'templates.update',
  'templates.delete',
  'template_blocks.set',
  'pages.create',
  'pages.update',
  'pages.set_modules',
  'pages.delete',
  'snapshots.revert_site',
  'snapshots.revert_module',
  'snapshots.revert_template',
  'snapshots.revert_page',
  'chat.publish',
  'layout_modules.set',
  'unknown'
));
