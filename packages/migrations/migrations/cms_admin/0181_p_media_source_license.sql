-- SPDX-License-Identifier: MPL-2.0
--
-- 0181 — media provenance: track where each asset came from and its
-- licence when known. Three nullable columns on media_assets:
--
--   source_kind   — one of 'upload' | 'ai_generated' | 'imported' |
--                   'external' (or NULL when the origin is unknown, e.g.
--                   assets created before this migration).
--   source_detail — the origin itself: the source URL for imported /
--                   external, "<provider>/<model>" for ai_generated,
--                   NULL/filename for a plain upload.
--   license       — the licence name/id when the operator states one.
--
-- These columns inherit the existing media_assets_authenticated_scope
-- RLS policy — no new policy is added (the table already has one, which
-- is all the RLS drift check requires).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE media_assets
  ADD COLUMN source_kind text
    CHECK (source_kind IS NULL OR source_kind IN ('upload', 'ai_generated', 'imported', 'external'));

ALTER TABLE media_assets
  ADD COLUMN source_detail text;

ALTER TABLE media_assets
  ADD COLUMN license text;

COMMIT;
