-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 8 — SEO sidecar + per-page hreflang stub + site-level SEO
-- defaults. Per-page SEO is structured fields, never raw HTML
-- (CLAUDE.md §2 "no raw HTML into <head>").
--
-- pages_seo is a separate sidecar so the existing pages.update path
-- stays narrow and the no-raw-HTML Validator on pages stays
-- mechanical. The renderer reads both at compose time.
--
-- Hreflang lives in <head> only (per crawler-coherency reasoning):
-- the schema column lands now, but P8's renderer iterates rows for
-- per-page hreflang; sitemap.xml deliberately stays single-locale
-- flat. P9 i18n populates pages_hreflang.

------------------------------------------------------------------------
-- pages_seo — one row per page; backfilled with defaults below.
------------------------------------------------------------------------
CREATE TABLE pages_seo (
  page_id           uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  meta_description  text NOT NULL DEFAULT '',
  og_image_asset_id uuid NULL REFERENCES media_assets(id),
  canonical_url     text NULL,
  noindex           boolean NOT NULL DEFAULT false,
  changefreq        text NOT NULL DEFAULT 'weekly'
    CHECK (changefreq IN ('always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never')),
  priority          numeric(2,1) NOT NULL DEFAULT 0.5
    CHECK (priority >= 0.0 AND priority <= 1.0),
  -- P8 fill-once contract: non-null only after the first publish.
  -- The seo-autofill skill checks this and bails on already-filled.
  autofilled_at     timestamptz NULL,
  -- Last time seo-optimize wrote here. Feeds the "stale SEO" tile.
  optimized_at      timestamptz NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES actors(id)
);

CREATE INDEX pages_seo_noindex_idx
  ON pages_seo (noindex) WHERE noindex = true;
CREATE INDEX pages_seo_optimized_idx
  ON pages_seo (optimized_at) WHERE optimized_at IS NULL;

ALTER TABLE pages_seo ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages_seo FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pages_seo_authenticated_scope ON pages_seo;
CREATE POLICY pages_seo_authenticated_scope ON pages_seo
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- Backfill: every existing live page gets a default sidecar row.
INSERT INTO pages_seo (page_id)
SELECT id FROM pages WHERE deleted_at IS NULL
ON CONFLICT (page_id) DO NOTHING;

--> statement-breakpoint

------------------------------------------------------------------------
-- pages_hreflang — forward-compat stub for P9 i18n.
-- Renderer iterates rows per page; sitemap.xml does NOT.
------------------------------------------------------------------------
CREATE TABLE pages_hreflang (
  page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  locale     text NOT NULL,
  url        text NOT NULL,
  PRIMARY KEY (page_id, locale)
);

CREATE INDEX pages_hreflang_page_idx ON pages_hreflang (page_id);

ALTER TABLE pages_hreflang ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages_hreflang FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pages_hreflang_authenticated_scope ON pages_hreflang;
CREATE POLICY pages_hreflang_authenticated_scope ON pages_hreflang
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- site_defaults — base URL + sitemap toggle + Organization JSON-LD.
------------------------------------------------------------------------
ALTER TABLE site_defaults
  ADD COLUMN site_base_url     text NOT NULL DEFAULT 'http://localhost:8082',
  ADD COLUMN sitemap_enabled   boolean NOT NULL DEFAULT true,
  ADD COLUMN organization_json jsonb NOT NULL DEFAULT '{}'::jsonb;

--> statement-breakpoint

------------------------------------------------------------------------
-- Snapshot op_kind extension. SEO writes get their own kinds so the
-- audit + revert path can distinguish autofill vs optimize vs manual.
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
  'pages_seo.set',
  'pages_seo.autofill',
  'pages_seo.optimize',
  'unknown'
));
