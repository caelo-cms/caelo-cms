-- SPDX-License-Identifier: MPL-2.0
--
-- 0326 — epic #724, rollout E: existing literal internal links become
-- page / media references.
--
-- The conversion itself is NOT in this file. Turning `/about` into
-- `caelo:page/<id>` needs the canonicaliser (shared
-- `link-canonicalise.ts`) and the site's page / redirect / media lookup,
-- which live in TypeScript; SQL migrations here are schema-only. The
-- data migration is the `links.migrate_to_references` Query API op,
-- triggered once by the admin at boot (apps/admin hooks.server.ts) after
-- the plugin host is up, and re-runnable by the Owner. This migration
-- adds what that op needs:
--
--   link_migration_runs   one row per run (dry run or apply): counts per
--                         surface, every link it could not convert (with
--                         where it was found), and the before/after of
--                         every row it changed so `links.revert_migration`
--                         can restore exactly that.
--   site_snapshots op kinds for the migration and its revert.
--
-- An import run's links to pages it had not built yet are rollout C's
-- (`import_run_links`, 0325, finalised by `imports.resolve_links`), not
-- this migration's.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS link_migration_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'dry_run' writes nothing but this row; 'apply' converts.
  mode             text NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  -- 'boot' (the one-time upgrade run) or 'manual' (Owner).
  trigger          text NOT NULL CHECK (trigger IN ('boot', 'manual')),
  actor_id         uuid NOT NULL REFERENCES actors(id),
  -- The migration's main-line snapshot (null for a dry run or a run that
  -- changed nothing on main).
  site_snapshot_id uuid NULL REFERENCES site_snapshots(id) ON DELETE SET NULL,
  -- { "<surface>": <links converted> }
  counts           jsonb NOT NULL DEFAULT '{}'::jsonb,
  entities_changed int  NOT NULL DEFAULT 0,
  -- [{ surface, entityKind, entityId, branchId, label, where, value, kind }]
  unresolved       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ entityKind, entityId, branchId, ..., before, after }] — the
  -- revert's input. Large on a big site, read only by the revert.
  changes          jsonb NOT NULL DEFAULT '[]'::jsonb,
  reverted_at      timestamptz NULL,
  reverted_by      uuid NULL REFERENCES actors(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS link_migration_runs_created_idx
  ON link_migration_runs (created_at DESC);

-- Same scope as the snapshot / import tables: any authenticated actor
-- session. Who may RUN the migration is decided at the op (human +
-- system), reading the report is open to the AI (CLAUDE.md §11).
ALTER TABLE link_migration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_migration_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS link_migration_runs_authenticated_scope ON link_migration_runs;
CREATE POLICY link_migration_runs_authenticated_scope ON link_migration_runs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- Same list as 0263 plus the migration's two kinds.
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
    'chat.discard_branch', 'chat.adopt_change', 'chat.undo_changes',
    'links.migrate_to_references', 'links.revert_migration'
  ));

COMMIT;
