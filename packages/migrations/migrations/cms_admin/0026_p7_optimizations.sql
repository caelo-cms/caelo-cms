-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 7 optimizations — five forward-looking surfaces:
--
--   1. Responsive srcset + LCP preload — pure rewrite at deploy, no
--      schema change required (variants already carry width/height).
--   2. Focal-point + per-asset named crops — adds focal_x / focal_y
--      to media_assets and a media_crops table.
--   3. Plugin-authored storage adapters — adds storage_provider tag
--      to media_assets so future adapters can stamp their origin
--      (e.g. 'r2', 's3'); 'local' for the LocalVolumeAdapter.
--   4. Background pipeline — processing_status enum + processed_at +
--      processing_error so the upload endpoint can return as soon as
--      the original blob lands and a worker fills variants async.
--   5. AI alt-text proposals — media_alt_proposals table mirrors the
--      site_memory_proposals shape: AI suggests, Owner reviews.
--
-- All new tables get FORCE RLS; new columns on media_assets inherit
-- the existing media_assets_authenticated_scope policy.

------------------------------------------------------------------------
-- 2 + 3 + 4. Add columns to media_assets.
------------------------------------------------------------------------

ALTER TABLE media_assets
  ADD COLUMN focal_x          double precision NOT NULL DEFAULT 0.5
    CHECK (focal_x >= 0.0 AND focal_x <= 1.0),
  ADD COLUMN focal_y          double precision NOT NULL DEFAULT 0.5
    CHECK (focal_y >= 0.0 AND focal_y <= 1.0),
  ADD COLUMN storage_provider text NOT NULL DEFAULT 'local',
  ADD COLUMN processing_status text NOT NULL DEFAULT 'ready'
    CHECK (processing_status IN ('processing', 'ready', 'failed')),
  ADD COLUMN processing_error text NULL,
  ADD COLUMN processed_at     timestamptz NULL;

-- A new asset is `ready` immediately when the pipeline is synchronous
-- (current default). Background workers (P7 optimization #4) will
-- INSERT with status='processing' and flip to 'ready'/'failed' when
-- they finish. The default keeps existing rows + the sync path stable.

CREATE INDEX media_assets_processing_idx
  ON media_assets (processing_status)
  WHERE processing_status <> 'ready' AND deleted_at IS NULL;

--> statement-breakpoint

------------------------------------------------------------------------
-- 2. media_crops — Owner-curated named crops fan out into the variant
--    set. Default crops: none (the seeded WebP-N variants are already
--    "natural"). When a row exists, the pipeline emits crop variants
--    keyed `<crop>-<width>` (e.g. `square-800`, `wide-1200`). The
--    client URL convention extends to `/_caelo/media/<id>/<crop>-<W>`.
------------------------------------------------------------------------

CREATE TABLE media_crops (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  name        text NOT NULL,                              -- e.g. 'square', 'wide'
  ratio       double precision NOT NULL CHECK (ratio > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, name)
);

CREATE INDEX media_crops_asset_idx ON media_crops (asset_id);

ALTER TABLE media_crops ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_crops FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_crops_authenticated_scope ON media_crops;
CREATE POLICY media_crops_authenticated_scope ON media_crops
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- 5. media_alt_proposals — AI-suggested alt text awaiting Owner
--    review. Mirrors the site_memory_proposals shape. Accept calls
--    media.update_alt; reject just stamps decided_* and the row stays
--    for audit.
------------------------------------------------------------------------

CREATE TABLE media_alt_proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  proposed_alt text NOT NULL,
  rationale    text NOT NULL DEFAULT '',
  proposed_by  uuid NOT NULL REFERENCES actors(id),
  proposed_at  timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz NULL,
  decided_by   uuid NULL REFERENCES actors(id),
  accepted     boolean NULL
);

-- One pending proposal per asset is the common case; allow more by not
-- adding a UNIQUE — Owner can compare. The pending-only view filters
-- on decided_at IS NULL.
CREATE INDEX media_alt_proposals_pending_idx
  ON media_alt_proposals (proposed_at DESC) WHERE decided_at IS NULL;
CREATE INDEX media_alt_proposals_asset_idx
  ON media_alt_proposals (asset_id);

ALTER TABLE media_alt_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_alt_proposals FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_alt_proposals_authenticated_scope ON media_alt_proposals;
CREATE POLICY media_alt_proposals_authenticated_scope ON media_alt_proposals
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
