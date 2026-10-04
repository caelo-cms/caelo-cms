-- SPDX-License-Identifier: MPL-2.0
-- media_assets.sha256 was UNIQUE across ALL rows (0024), soft-deleted ones
-- included, while every lookup (media.upload's dedupe, imports) only looks
-- at live rows. Re-uploading content whose earlier asset had been deleted
-- therefore missed the dedupe and then failed on the constraint — an upload,
-- import or generated image that matched a deleted asset could not be saved.
--
-- Uniqueness now holds among live rows, the same shape as the slug index
-- (0192): one live asset per content hash; deleted history stays as it is.
ALTER TABLE media_assets DROP CONSTRAINT media_assets_sha256_key;
CREATE UNIQUE INDEX media_assets_sha256_live_unique ON media_assets (sha256)
  WHERE deleted_at IS NULL;
