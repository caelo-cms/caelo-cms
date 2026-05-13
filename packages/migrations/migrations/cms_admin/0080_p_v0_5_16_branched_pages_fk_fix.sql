-- SPDX-License-Identifier: MPL-2.0

-- v0.5.16 — drop FK constraints on page_snapshots.page_id and
-- page_layout_snapshots.page_id.
--
-- v0.5.7 introduced branched `pages.create`: the op allocates a UUID
-- via gen_random_uuid() and emits a snapshot, but skips the live
-- INSERT INTO pages until publish materializes the row. The
-- pre-existing FK constraint
--   page_snapshots.page_id NOT NULL REFERENCES pages(id)
-- rejects every branched-page snapshot insert because the live pages
-- row doesn't exist yet. Same for page_layout_snapshots.
--
-- Snapshots are append-only history and carry the full page state in
-- their JSONB column — they're authoritative for their own row.
-- Orphan snapshots (where the page never materialised, e.g. branched
-- create then discard) are harmless: snapshot-reading code already
-- handles "no live page" cases by treating the snapshot as the source
-- of truth on a branch.

ALTER TABLE page_snapshots
  DROP CONSTRAINT IF EXISTS page_snapshots_page_id_fkey;

ALTER TABLE page_layout_snapshots
  DROP CONSTRAINT IF EXISTS page_layout_snapshots_page_id_fkey;

-- Keep the index on page_id for snapshot lookups; just drop the FK.
