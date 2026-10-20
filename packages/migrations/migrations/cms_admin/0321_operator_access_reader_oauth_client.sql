-- SPDX-License-Identifier: MPL-2.0
--
-- 0321 — issue #914: the operator-access sync job reads the install's Google
-- sign-in client ID (0320) so it can set the admin IAP resource's
-- `oauthSettings` (browser login client + programmatic clients) to exactly
-- that client. Replaces 0314's grant, which went with the dropped
-- mcp_remote_oauth_client table.
--
-- The smallest extension of the job's read-only role (0239): SELECT on the
-- one column it needs, plus a read-only policy so the row is visible
-- regardless of the session's caelo.actor_kind. No writes, no other column.
--
-- Same guard as 0239: an install whose admin_role could not create the role
-- (self-hosted without CREATEROLE) has no sync job and no IAP, so this
-- grants nothing there.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operator_access_reader') THEN
    EXECUTE 'GRANT SELECT (client_id) ON operator_oauth_client TO operator_access_reader';
    EXECUTE 'DROP POLICY IF EXISTS operator_oauth_client_operator_access_read ON operator_oauth_client';
    EXECUTE 'CREATE POLICY operator_oauth_client_operator_access_read ON operator_oauth_client FOR SELECT TO operator_access_reader USING (true)';
  END IF;
END
$$;
