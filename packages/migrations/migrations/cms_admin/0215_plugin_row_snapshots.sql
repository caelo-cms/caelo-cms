-- SPDX-License-Identifier: MPL-2.0
--
-- Branch-aware plugin storage (docs/branch-aware-plugin-storage.md,
-- CMS_REQUIREMENTS §14.7).
--
-- A plugin's private-zone rows follow the same branch pattern as core
-- content: a write that originates in a chat is recorded against the
-- chat's branch and reaches live only when the branch is published. An
-- update or delete on a branch never touches the live row; its full new
-- state is written here, tagged with the branch through site_snapshots —
-- exactly how content_instance_snapshots overlays content instances.
-- Main-line writes are snapshotted here too, so a published change can
-- be reverted.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE plugin_row_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  plugin_id         uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  -- The plugin's private schema + table the row lives in. Kept as text:
  -- plugin tables are provisioned per plugin and have no core FK target.
  schema_name       text NOT NULL,
  table_name        text NOT NULL,
  row_id            uuid NOT NULL,
  -- state = PluginRowState (packages/plugin-host/src/row-snapshots.ts):
  -- {schemaVersion, values, deletedAt, version}
  state             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX plugin_row_snapshots_row_idx
  ON plugin_row_snapshots (plugin_id, table_name, row_id, site_snapshot_id);
CREATE INDEX plugin_row_snapshots_site_idx
  ON plugin_row_snapshots (site_snapshot_id);

ALTER TABLE plugin_row_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_row_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plugin_row_snapshots_scope ON plugin_row_snapshots;
-- Any authenticated actor, except that a plugin sees and writes only its
-- own rows' history — never another plugin's.
CREATE POLICY plugin_row_snapshots_scope ON plugin_row_snapshots
  USING (
    NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL
    AND (
      current_setting('caelo.actor_kind', true) <> 'plugin'
      OR plugin_id::text = current_setting('caelo.plugin_id', true)
    )
  )
  WITH CHECK (
    NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL
    AND (
      current_setting('caelo.actor_kind', true) <> 'plugin'
      OR plugin_id::text = current_setting('caelo.plugin_id', true)
    )
  );
GRANT SELECT, INSERT, DELETE ON plugin_row_snapshots TO admin_role;

-- Snapshot op kinds for plugin storage writes.
ALTER TABLE site_snapshots DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots
  ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
    'modules.create',
    'modules.update',
    'modules.delete',
    'templates.create',
    'templates.update',
    'templates.delete',
    'template_blocks.set',
    'pages.create',
    'pages.update',
    'pages.set_modules',
    'pages.delete',
    'snapshots.revert_site',
    'snapshots.revert_module',
    'snapshots.revert_template',
    'snapshots.revert_page',
    'chat.publish',
    'chat.merge_to_main',
    'chat.stage',
    'chat.unstage',
    'layout_modules.set',
    'page_module_content.set',
    'structured_sets.set',
    'redirects.create',
    'redirects.update',
    'redirects.delete',
    'content_instances.create',
    'content_instances.set_values',
    'content_instances.delete',
    'placement.set_content',
    'placement.fork_content',
    'unknown',
    'themes.update_tokens',
    'themes.set_asset',
    'themes.duplicate',
    'themes.import_dtcg',
    'themes.import',
    'themes.activate',
    'themes.update_meta',
    -- Branch-aware plugin storage.
    'plugin_storage.insert',
    'plugin_storage.update',
    'plugin_storage.delete',
    'chat.discard_branch'
  ));

-- Plugin rows join the lock and publish-mark vocabularies.
ALTER TABLE chat_entity_locks DROP CONSTRAINT IF EXISTS chat_entity_locks_entity_kind_check;
ALTER TABLE chat_entity_locks
  ADD CONSTRAINT chat_entity_locks_entity_kind_check
  CHECK (entity_kind IN (
    'module',
    'template',
    'pageLayout',
    'layout',
    'structuredSet',
    'redirect',
    'page',
    'siteSettings',
    'siteDefaults',
    'contentInstance',
    'theme',
    'pluginRow'
  ));

ALTER TABLE entity_leases DROP CONSTRAINT IF EXISTS entity_leases_entity_kind_check;
ALTER TABLE entity_leases
  ADD CONSTRAINT entity_leases_entity_kind_check
  CHECK (entity_kind IN (
    'module',
    'template',
    'pageLayout',
    'layout',
    'structuredSet',
    'redirect',
    'page',
    'siteSettings',
    'siteDefaults',
    'contentInstance',
    'theme',
    'pluginRow'
  ));

ALTER TABLE chat_branch_publish_marks
  DROP CONSTRAINT IF EXISTS chat_branch_publish_marks_entity_kind_check;
ALTER TABLE chat_branch_publish_marks
  ADD CONSTRAINT chat_branch_publish_marks_entity_kind_check
  CHECK (entity_kind IN (
    'module',
    'template',
    'page',
    'pageLayout',
    'pageModuleContent',
    'layout',
    'structuredSet',
    'structuredSetOperation',
    'redirect',
    'theme',
    'contentInstance',
    'pluginRow'
  ));

-- A plugin acting in a chat takes per-task entity leases exactly like the
-- AI does (its core writes via ctx.cms.call and its own branched rows),
-- scoped to the same branch / task.
DROP POLICY IF EXISTS entity_leases_per_actor_scope ON entity_leases;
CREATE POLICY entity_leases_per_actor_scope ON entity_leases
  USING (
    current_setting('caelo.actor_kind', true) IN ('human', 'system')
    OR (
      current_setting('caelo.actor_kind', true) IN ('ai', 'plugin')
      AND (
        branch_id = NULLIF(current_setting('caelo.chat_branch_id', true), '')::uuid
        OR holder_key = NULLIF(current_setting('caelo.chat_task_id', true), '')
      )
    )
  )
  WITH CHECK (
    current_setting('caelo.actor_kind', true) IN ('human', 'system')
    OR (
      current_setting('caelo.actor_kind', true) IN ('ai', 'plugin')
      AND (
        branch_id = NULLIF(current_setting('caelo.chat_branch_id', true), '')::uuid
        OR holder_key = NULLIF(current_setting('caelo.chat_task_id', true), '')
      )
    )
  );

-- chat.discard_branch closes a chat after dropping its branch state; a
-- discarded chat can never be merged, or it would resurrect the rows the
-- discard dropped.
ALTER TABLE chat_sessions ADD COLUMN discarded_at timestamptz NULL;

COMMIT;
