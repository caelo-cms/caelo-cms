-- SPDX-License-Identifier: MPL-2.0
--
-- 0452 — stored digests of every media file (#1271).
--
-- A Stage used to read every referenced image and variant to name it
-- (`_assets/<slug>.<hash>.<ext>`, #667), copy it into the build (on Cloud
-- Run: memory) and gzip + hash it again in the publisher. On 2026-10-30
-- that OOM-killed a 2 GiB admin staging 122 pages. The digests are now
-- taken once, when the file is written, and the build passes references:
--
--   content_sha256  sha256 of the stored bytes (hex). Its prefix is the
--                   content hash in the published name.
--   gzip_sha256     sha256 of the bytes gzipped as the Firebase Hosting
--   gzip_size       publisher uploads them, and that gzip's length:
--                   Hosting keys files by it (populateFiles), so the
--                   publisher learns which media it lacks without reading
--                   any, and streams only those.
--   digest_profile  which gzip produced gzip_sha256 (published-digest.ts in
--                   the static generator). A row from another profile is
--                   digested again before the next build, never trusted.
--
-- Derived state (#1267 rule 3): every write path stores them with the
-- variant (media.upload, media.regenerate_variants, the favicon rendition);
-- the backfill and the rebuild are the op `media.rebuild_digests` — Stage
-- runs it for rows still without digests (written before this migration,
-- or by the previous release during an upgrade, which does not know the
-- columns) before the generator starts, and it can rebuild every row; the
-- consistency test is media-digests.integration.test.ts in admin-core.
--
-- Expand-only: nullable columns the previous release ignores. The CHECK
-- keeps the four together, so a half-written digest cannot exist.

ALTER TABLE media_variants
  ADD COLUMN IF NOT EXISTS content_sha256 text,
  ADD COLUMN IF NOT EXISTS gzip_sha256 text,
  ADD COLUMN IF NOT EXISTS gzip_size bigint,
  ADD COLUMN IF NOT EXISTS digest_profile text;

--> statement-breakpoint

ALTER TABLE media_variants DROP CONSTRAINT IF EXISTS media_variants_digest_shape;
ALTER TABLE media_variants ADD CONSTRAINT media_variants_digest_shape CHECK (
  (content_sha256 IS NULL AND gzip_sha256 IS NULL AND gzip_size IS NULL AND digest_profile IS NULL)
  OR (
    content_sha256 ~ '^[0-9a-f]{64}$'
    AND gzip_sha256 ~ '^[0-9a-f]{64}$'
    AND gzip_size >= 0
    AND length(digest_profile) BETWEEN 1 AND 64
  )
);

--> statement-breakpoint

-- What the backfill looks for before every build: rows without digests.
CREATE INDEX IF NOT EXISTS media_variants_undigested_idx
  ON media_variants (asset_id)
  WHERE content_sha256 IS NULL;
