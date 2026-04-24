-- SPDX-License-Identifier: MPL-2.0
--
-- RLS policies + grants for cms_public. Every plugin table (P11+) must also
-- ship an RLS policy referencing current_setting('caelo.plugin_id') or the
-- drift check in migrate.ts fails loudly.

ALTER TABLE rls_sentinel ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_sentinel FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_sentinel_plugin_scope ON rls_sentinel;
CREATE POLICY rls_sentinel_plugin_scope ON rls_sentinel
  USING (plugin_id = NULLIF(current_setting('caelo.plugin_id', true), ''))
  WITH CHECK (plugin_id = NULLIF(current_setting('caelo.plugin_id', true), ''));

-- public_role grants. Per-plugin INSERT/SELECT grants will be added by the
-- plugin registration flow in P11 when the SDK materialises a plugin's tables.
GRANT USAGE ON SCHEMA public TO public_role;
GRANT SELECT, INSERT ON rls_sentinel TO public_role;
