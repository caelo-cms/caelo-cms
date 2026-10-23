-- SPDX-License-Identifier: MPL-2.0
--
-- 0301 — issue #1008: record which DDL provisioned each plugin schema in
-- cms_public. Mirror of cms_admin 0343 (see there for the why): the
-- adapter serialises plugin schema provisioning with an advisory lock and
-- skips the DDL when the recorded digest matches and the schema exists.
--
-- Written and read only by admin_role `system` sessions. public_role gets
-- no grant: the gateway never provisions schemas.

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
