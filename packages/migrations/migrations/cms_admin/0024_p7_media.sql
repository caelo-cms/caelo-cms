-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 7 — Media library.
--
-- Two tables: `media_assets` (one row per content hash) + `media_variants`
-- (one row per emitted file: `orig` plus `webp-1600` / `webp-1200` /
-- `webp-800` / `webp-400` etc.).
--
-- Splitting variants out keeps the asset row stable when we add new
-- variant tiers (AVIF, mobile-only) — the asset row is canonical, the
-- variants are derived.
--
-- Storage-key format: <sha>/<variant>.<ext>. Adapters compose the full
-- path (LocalVolumeAdapter prefixes with rootDir; cloud adapters with
-- bucket key). The DB never holds blob bytes.
--
-- usage_count is a denormalised counter updated by
-- packages/admin-core/src/ops/media/record_usage.ts; called from a
-- post-write hook on every modules.update so the AI's `## Media` system
-- prompt block surfaces frequently-used assets.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE media_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256        text NOT NULL UNIQUE,
  original_name text NOT NULL,
  mime          text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  width         int NULL,
  height        int NULL,
  alt           text NOT NULL DEFAULT '',
  storage_key   text NOT NULL,
  usage_count   int NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  last_used_at  timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES actors(id),
  deleted_at    timestamptz NULL
);

CREATE INDEX media_assets_mime_idx
  ON media_assets (mime) WHERE deleted_at IS NULL;
CREATE INDEX media_assets_usage_idx
  ON media_assets (usage_count DESC, last_used_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;
CREATE INDEX media_assets_alt_trgm_idx
  ON media_assets USING GIN (alt gin_trgm_ops);
CREATE INDEX media_assets_recent_idx
  ON media_assets (created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_assets_authenticated_scope ON media_assets;
CREATE POLICY media_assets_authenticated_scope ON media_assets
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

CREATE TABLE media_variants (
  asset_id     uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  variant      text NOT NULL,
  format       text NOT NULL,
  width        int NULL,
  height       int NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  storage_key  text NOT NULL,
  PRIMARY KEY (asset_id, variant)
);

CREATE INDEX media_variants_asset_idx ON media_variants (asset_id);

ALTER TABLE media_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_variants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_variants_authenticated_scope ON media_variants;
CREATE POLICY media_variants_authenticated_scope ON media_variants
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

-- CDN-copy toggle + threshold live on the singleton site_defaults row.
-- The actual cloud upload is the P15 adapter's job; P7 only emits the
-- cdn_manifest.json from the static generator.
ALTER TABLE site_defaults
  ADD COLUMN media_cdn_copy_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN media_cdn_usage_threshold int NOT NULL DEFAULT 5
    CHECK (media_cdn_usage_threshold >= 1);

--> statement-breakpoint

-- Extend op_kind CHECK so media snapshots persist. Drop + recreate per
-- the established pattern.
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
  'media.upload',
  'media.update_alt',
  'media.delete',
  'unknown'
));
