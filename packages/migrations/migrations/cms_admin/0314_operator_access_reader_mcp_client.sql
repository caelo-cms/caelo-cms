-- SPDX-License-Identifier: MPL-2.0
--
-- 0314 — issue #806: the operator-access sync job reads the remote-MCP
-- OAuth client ID (0313) so it can keep the admin IAP resource's
-- `programmatic_clients` at exactly that client.
--
-- The smallest extension of the job's read-only role (0239): SELECT on the
-- one column it needs, plus a read-only policy so the row is visible
-- regardless of the session's caelo.actor_kind (same reason as 0239's
-- users_operator_access_read). No writes, no other column.
--
-- Same guard as 0239: an install whose admin_role could not create the role
-- (self-hosted without CREATEROLE) has no sync job and no IAP, so this
-- grants nothing there.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operator_access_reader') THEN
    EXECUTE 'GRANT SELECT (client_id) ON mcp_remote_oauth_client TO operator_access_reader';
    EXECUTE 'DROP POLICY IF EXISTS mcp_remote_oauth_client_operator_access_read ON mcp_remote_oauth_client';
    EXECUTE 'CREATE POLICY mcp_remote_oauth_client_operator_access_read ON mcp_remote_oauth_client FOR SELECT TO operator_access_reader USING (true)';
  END IF;
END
$$;
