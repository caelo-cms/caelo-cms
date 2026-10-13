-- SPDX-License-Identifier: MPL-2.0
--
-- 0263 — nested page URLs (parent pages).
--
-- A page may sit under a parent page; its public path is the ancestor
-- chain's slugs plus its own (`/seo-monitoring/alerts`), with URL-plugin
-- contributions (an `/de` prefix, …) applied on top by the core resolver
-- (plugin-host url-composition). The composed result stays materialized
-- in `pages.current_path` — the write ops recompute a page AND its whole
-- subtree whenever a slug or parent changes.
--
-- Referential shape:
--   * NO ACTION (not RESTRICT): pages are soft-deleted; the ops refuse to
--     soft-delete a page that still has live children. A hard DELETE of a
--     whole subtree in one statement (test teardown) stays valid because
--     NO ACTION is checked at statement end.
--   * Cycle, depth (max 6 levels) and "the homepage neither has nor is a
--     parent" are op-level rules (pages.create / pages.move_many) — they
--     need the branch view, which a CHECK constraint cannot see. The CHECK
--     below only rules out the trivial self-loop.
--
-- The current_path INSERT default (0211/0221) learns the parent: a child
-- inserted outside the ops (seeds, import tooling) defaults to
-- "<parent path>/<slug>" instead of "/<slug>", so it cannot collide with
-- a root-level page of the same name before the op recompute runs.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS parent_page_id uuid NULL REFERENCES pages(id);

ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_parent_not_self;
ALTER TABLE pages ADD CONSTRAINT pages_parent_not_self CHECK (parent_page_id <> id);

CREATE INDEX IF NOT EXISTS pages_parent_page_idx
  ON pages (parent_page_id)
  WHERE parent_page_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION pages_default_current_path() RETURNS trigger AS $$
DECLARE
  parent_path text;
BEGIN
  IF NEW.current_path IS NULL THEN
    IF NEW.parent_page_id IS NOT NULL THEN
      SELECT current_path INTO parent_path FROM pages WHERE id = NEW.parent_page_id;
      IF parent_path IS NULL THEN
        RAISE EXCEPTION 'pages: parent page % not found', NEW.parent_page_id;
      END IF;
      NEW.current_path := rtrim(parent_path, '/') || '/' || NEW.slug;
    ELSIF btrim(NEW.slug, '/') IN ('', 'home', 'index')
       AND NOT EXISTS (
         SELECT 1 FROM site_defaults WHERE id = 1 AND home_page_id IS NOT NULL
       ) THEN
      NEW.current_path := '/';
    ELSE
      NEW.current_path := '/' || NEW.slug;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- pages.move_many emits its own snapshot kind (one snapshot per move
-- call, every moved page an entity), so the history reads "moved pages"
-- instead of a generic update. Same list as 0245 plus the new kind.
ALTER TABLE site_snapshots DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots
  ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
    'modules.create', 'modules.update', 'modules.delete',
    'templates.create', 'templates.update', 'templates.delete', 'template_blocks.set',
    'pages.create', 'pages.update', 'pages.set_modules', 'pages.delete', 'pages.move_many',
    'snapshots.revert_site', 'snapshots.revert_module', 'snapshots.revert_template',
    'snapshots.revert_page',
    'chat.publish', 'chat.merge_to_main', 'chat.stage', 'chat.unstage',
    'layout_modules.set', 'page_module_content.set', 'structured_sets.set',
    'redirects.create', 'redirects.update', 'redirects.delete',
    'content_instances.create', 'content_instances.set_values', 'content_instances.delete',
    'placement.set_content', 'placement.fork_content', 'unknown',
    'themes.update_tokens', 'themes.set_asset', 'themes.duplicate', 'themes.import_dtcg',
    'themes.import', 'themes.activate', 'themes.update_meta',
    'plugin_storage.insert', 'plugin_storage.update', 'plugin_storage.delete',
    'chat.discard_branch', 'chat.adopt_change', 'chat.undo_changes'
  ));

COMMIT;
