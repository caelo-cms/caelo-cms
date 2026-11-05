-- SPDX-License-Identifier: MPL-2.0
--
-- 0625 — issue #1461: small static files on the site's domain (JSON, TXT,
-- CSV, XML), served at a chosen path the way robots.txt is. Docs:
-- docs/dev/static-files.md.
--
--   static_files                the files. One row per path for good: a
--                               deleted path keeps its row (`deleted_at`), so
--                               a later write to that path and a revert both
--                               land on it and history stays one line.
--   static_file_snapshots       state = StaticFileState
--                               (packages/admin-core/src/snapshots/state.ts).
--   static_file_pending_actions the §11.A queue: a file at a chosen path can
--                               prove domain ownership to a third party, so
--                               the AI proposes and the Owner approves.
--
-- No `chat_branch_id`: every AI write of this table is approved and applied
-- with the approver's branch-free context, like an approved template update,
-- so there is nothing to overlay. The draft boundary is the build: the
-- generator is the only reader that reaches a visitor, and it runs at Stage;
-- production gets what a human Publish live copies from there.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE static_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path         text NOT NULL UNIQUE CHECK (path ~ '^/' AND path !~ '/$'),
  content_type text NOT NULL CHECK (content_type IN
                 ('application/json', 'text/plain', 'text/csv', 'application/xml', 'text/xml')),
  body         text NOT NULL,
  -- Why this file exists and who reads it (CLAUDE.md §1A).
  purpose      text NOT NULL,
  version      bigint NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES actors(id),
  deleted_at   timestamptz
);
CREATE INDEX static_files_updated_by_idx ON static_files (updated_by);

CREATE TABLE static_file_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  static_file_id   uuid NOT NULL REFERENCES static_files(id) ON DELETE CASCADE,
  state            jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX static_file_snapshots_entity_idx
  ON static_file_snapshots (static_file_id, created_at DESC);
CREATE INDEX static_file_snapshots_site_idx ON static_file_snapshots (site_snapshot_id);

CREATE TABLE static_file_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('set', 'delete')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  decided_by      uuid REFERENCES actors(id),
  decision_reason text,
  chat_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  payload_hash    text
);
CREATE UNIQUE INDEX static_file_pending_actions_payload_hash_pending_uniq
  ON static_file_pending_actions (payload_hash)
  WHERE status = 'pending' AND payload_hash IS NOT NULL;
CREATE INDEX static_file_pending_actions_status_idx
  ON static_file_pending_actions (status, created_at DESC);
CREATE INDEX static_file_pending_actions_proposed_by_idx
  ON static_file_pending_actions (proposed_by);
CREATE INDEX static_file_pending_actions_decided_by_idx
  ON static_file_pending_actions (decided_by);
CREATE INDEX static_file_pending_actions_chat_session_idx
  ON static_file_pending_actions (chat_session_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'static_files', 'static_file_snapshots', 'static_file_pending_actions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- Any authenticated actor session; who may write what is decided at the op.
    EXECUTE format(
      'CREATE POLICY %I ON %I '
      'USING (NULLIF(current_setting(''caelo.actor_kind'', true), '''') IS NOT NULL) '
      'WITH CHECK (NULLIF(current_setting(''caelo.actor_kind'', true), '''') IS NOT NULL)',
      t || '_authenticated_scope', t);
  END LOOP;
END $$;

ALTER TABLE site_snapshots DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots
  ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
    'modules.create', 'modules.update', 'modules.delete',
    'static_files.set_many', 'static_files.delete_many',
    'templates.create', 'templates.update', 'templates.delete', 'template_blocks.set',
    'pages.create', 'pages.update', 'pages.set_modules', 'pages.delete', 'pages.move_many',
    'snapshots.revert_site', 'snapshots.revert_module', 'snapshots.revert_template',
    'snapshots.revert_page',
    'chat.publish', 'chat.merge_to_main', 'chat.stage', 'chat.unstage',
    'layout_modules.set', 'page_module_content.set',
    'redirects.create', 'redirects.update', 'redirects.delete',
    'content_instances.create', 'content_instances.set_values', 'content_instances.delete',
    'placement.set_content', 'placement.fork_content', 'unknown',
    'themes.update_tokens', 'themes.set_asset', 'themes.duplicate', 'themes.import_dtcg',
    'themes.import', 'themes.activate', 'themes.update_meta',
    'plugin_storage.insert', 'plugin_storage.update', 'plugin_storage.delete',
    'chat.discard_branch', 'chat.adopt_change', 'chat.undo_changes',
    'links.migrate_to_references', 'links.revert_migration',
    'list_types.upsert_many', 'list_types.delete_many',
    'lists.upsert_many', 'lists.patch_items_many', 'lists.delete_many', 'lists.promote_local',
    'page_types.upsert_many', 'page_types.delete_many',
    'pages_seo.set', 'pages_seo.autofill', 'pages_seo.optimize', 'pages_seo.apply_translation'
  ));

SELECT caelo_journal_attach('static_files', 'static_file', 'id', 'row', 'id');
SELECT caelo_journal_attach('static_file_snapshots', 'static_file', 'static_file_id', 'snapshot', 'id');

COMMIT;
