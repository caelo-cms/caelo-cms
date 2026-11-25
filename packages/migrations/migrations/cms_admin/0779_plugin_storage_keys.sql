-- SPDX-License-Identifier: MPL-2.0
--
-- 0779 — issue #1659: the key a plugin writes a private table's rows by.
--
-- `ctx.adminQuery.upsert` keeps a key of a private table at one row within
-- one line (main, or one branch): a lock on the key serialises its writes.
-- A row a branch creates for a key is invisible to the main line and to
-- other branches until it is staged, so two lines can each hold a row of
-- the key. The Stage merge folds them (plugin-host `key-merge.ts`): a row
-- the branch created is applied onto the key's existing main row, and the
-- branch's row is dropped. For that the merge needs the table's key, which
-- the plugin names on every upsert and the host records here.
--
-- One row per private table: the key of its latest upsert. The table holds
-- host bookkeeping about plugin tables, nothing derives from it.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS plugin_storage_keys (
  plugin_id    uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  table_name   text NOT NULL CHECK (table_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  key_columns  text[] NOT NULL CHECK (cardinality(key_columns) BETWEEN 1 AND 4),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, table_name)
);

ALTER TABLE plugin_storage_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_storage_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plugin_storage_keys_scope ON plugin_storage_keys;
-- Any authenticated actor, except that a plugin reads and writes only its
-- own tables' keys (as plugin_row_snapshots).
CREATE POLICY plugin_storage_keys_scope ON plugin_storage_keys
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

COMMIT;
