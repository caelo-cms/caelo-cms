-- SPDX-License-Identifier: MPL-2.0
--
-- #390 (epic #380) — materialize the composed public path.
--
-- The URL composition point lets plugins reshape page URLs (path
-- prefixes, host splits, slug formats). `pages.current_path` stores the
-- COMPOSED result so that:
--   1. render-time consumers (generator, canonical, sitemap, staging
--      preview) read one column instead of five re-implementations of
--      slug→path;
--   2. request-time inversion (preview-by-path) is an index lookup;
--   3. URL-shape changes are DIFFABLE AFTER the causing plugin is gone
--      (decision 4): the diff engine compares stored paths against a
--      fresh resolution — the old paths survive in this column.
--
-- Backfill: with no URL plugins active the composed path is "/<slug>",
-- and the designated homepage (site_defaults.home_page_id, with the
-- legacy magic slugs as fallback designation) serves at "/". The
-- create-op root backstop keeps designated + magic-slug homepages from
-- coexisting, so the backfill's precedence (designated first, magic
-- slugs only when no designation exists) cannot double-assign "/".
--
-- url_migration_pending_actions is the §11.A pending table for the
-- generic URL-diff engine (propose_url_migration → execute_proposal):
-- canonical shape per 0055, payload carries the full page diff.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE pages ADD COLUMN IF NOT EXISTS current_path text;

-- Backfill live + branched rows: designated home → '/', others → '/<slug>'.
UPDATE pages
   SET current_path = CASE
     WHEN id = (SELECT home_page_id FROM site_defaults WHERE id = 1) THEN '/'
     WHEN (SELECT home_page_id FROM site_defaults WHERE id = 1) IS NULL
          AND slug IN ('', 'home', 'index') THEN '/'
     ELSE '/' || slug
   END
 WHERE current_path IS NULL;

ALTER TABLE pages ALTER COLUMN current_path SET NOT NULL;

-- Write-time default derivation (NOT a read-time fallback): an INSERT
-- that doesn't supply current_path gets the composition-free default
-- "/<slug>". The write ops recompute the composed value in the same
-- transaction right after; this trigger keeps out-of-op INSERTs (test
-- seeds, import tooling) valid under the NOT NULL constraint without
-- teaching every caller about URL composition.
CREATE OR REPLACE FUNCTION pages_default_current_path() RETURNS trigger AS $$
BEGIN
  IF NEW.current_path IS NULL THEN
    NEW.current_path := '/' || NEW.slug;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pages_current_path_default ON pages;
CREATE TRIGGER pages_current_path_default
  BEFORE INSERT ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_default_current_path();

-- Same branch-aware uniqueness shape as pages_slug_branch_uidx (0201).
CREATE UNIQUE INDEX IF NOT EXISTS pages_current_path_branch_uidx
  ON pages (current_path, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS url_migration_pending_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('migrate')),
  proposed_by      uuid NOT NULL REFERENCES actors(id),
  payload          jsonb NOT NULL,
  preview          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  chat_session_id  uuid NULL,
  payload_hash     text NOT NULL,
  decided_by       uuid NULL REFERENCES actors(id),
  decided_at       timestamptz NULL,
  decision_reason  text NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One live proposal per identical payload (dedup, same as every
-- *_pending_actions table).
CREATE UNIQUE INDEX IF NOT EXISTS url_migration_pending_dedup_uidx
  ON url_migration_pending_actions (payload_hash)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS url_migration_pending_status_idx
  ON url_migration_pending_actions (status, created_at);

ALTER TABLE url_migration_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE url_migration_pending_actions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS url_migration_pending_rw ON url_migration_pending_actions;
CREATE POLICY url_migration_pending_rw ON url_migration_pending_actions
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'))
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'));

GRANT SELECT, INSERT, UPDATE, DELETE ON url_migration_pending_actions TO admin_role;

COMMIT;
