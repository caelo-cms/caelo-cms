-- SPDX-License-Identifier: MPL-2.0
-- #531 — reference images. Some images exist only to guide generation or
-- editing (a character sheet, a style sample, a product shot to match):
-- they must not appear in the library the AI picks page images from, and
-- must never ship on a published page by accident.
--
-- `library` (default) is today's behaviour: listed, placeable, published
-- when a page references it. `reference` is listed only on request, and
-- the static generator refuses to publish a page that references it.
-- Public exposure stays reference-driven either way: only assets a
-- published page uses reach the CDN.
ALTER TABLE media_assets
  ADD COLUMN visibility text NOT NULL DEFAULT 'library'
    CHECK (visibility IN ('library', 'reference'));

CREATE INDEX media_assets_visibility_idx ON media_assets (visibility)
  WHERE deleted_at IS NULL;
