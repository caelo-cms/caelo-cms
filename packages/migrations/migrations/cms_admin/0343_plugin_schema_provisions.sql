-- SPDX-License-Identifier: MPL-2.0
--
-- 0343 — issue #1008: record which DDL provisioned each plugin schema.
--
-- Every admin instance provisions the schemas of its active plugins when it
-- boots (plugin-host `registerLoadedPlugin`). The emitted DDL is IF NOT
-- EXISTS guarded, but it is not safe when several instances run it at once:
-- on 2026-10-22 four instances booted in the same second and the DDL failed
-- on one of them. The adapter now serialises provisioning per schema with an
-- advisory lock and writes the digest of the SQL it ran here; an instance
-- that finds the same digest (and the schema still present) runs no DDL at
-- all, so a boot no longer takes ACCESS EXCLUSIVE locks on live plugin
-- tables either. Dropping the schema deletes its row.
--
-- Same table in cms_public (0301), because each database provisions its own
-- plugin schemas and the two never read each other.
--
-- Written and read only by `system` sessions (the plugin host). No grant to
-- public_role is needed or wanted.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE plugin_schema_provisions (
  schema_name    text PRIMARY KEY CHECK (schema_name ~ '^plugin_[a-z][a-z0-9_]*$'),
  sql_digest     text NOT NULL CHECK (sql_digest ~ '^[0-9a-f]{64}$'),
  provisioned_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plugin_schema_provisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_schema_provisions FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_schema_provisions_system ON plugin_schema_provisions
  USING (current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

COMMIT;
