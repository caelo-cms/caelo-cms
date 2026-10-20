-- SPDX-License-Identifier: MPL-2.0
--
-- 0320 — issue #914: the install's Google sign-in client.
--
-- One Owner-created Google OAuth client per install serves three uses:
--
--   * IAP browser login — set as the admin IAP resource's
--     `oauthSettings.clientId` / `clientSecret`, so accounts outside the
--     project's Google organisation (gmail.com, other Workspaces) can sign in;
--     the Google-managed client IAP uses by default admits the organisation's
--     own accounts only;
--   * IAP programmatic access — `oauthSettings.programmaticClients`;
--   * the remote-MCP broker (#806), which signs MCP users in with it.
--
-- #806 introduced it as the remote-MCP client (`mcp_remote_oauth_client`,
-- 0313/0314). It is renamed for what it now is. Pre-1.0 delete-don't-migrate:
-- the old table goes; nobody had configured it when this shipped, so there
-- is no row to carry over (the Owner pastes the client under Settings →
-- Google sign-in).
--
-- The client SECRET never touches the database: the admin writes
-- `{client_id, client_secret}` straight into the Secret Manager secret
-- `caelo-<env>-operator-oauth-client` (add-version only). This table keeps
-- the client ID for the operator-access sync job (read with its read-only
-- role, 0321) and the setup pages. At most one row (`id` is always true);
-- no row = Google sign-in not set up (IAP uses the Google-managed client).

DROP TABLE IF EXISTS mcp_remote_oauth_client;
DROP FUNCTION IF EXISTS caelo_mcp_remote_oauth_writer();

CREATE TABLE IF NOT EXISTS operator_oauth_client (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- A Google OAuth 2.0 client ID: `<project number>-<random>.apps.googleusercontent.com`.
  client_id     text NOT NULL
                CHECK (client_id ~ '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$'),
  configured_by uuid NOT NULL REFERENCES actors(id),
  configured_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE operator_oauth_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_oauth_client FORCE ROW LEVEL SECURITY;

-- Any authenticated session may read (the client ID is not a secret: it is
-- in every Google sign-in URL). Writes decide which OAuth client Google IAP
-- signs people in with and accepts programmatically, so they are system or
-- a human holding settings.write — at the Postgres layer, not only in the
-- route guard (CLAUDE.md §2). The AI never writes here. `caelo.actor_id` is
-- compared as text so a malformed id matches nobody instead of failing the
-- cast.
DROP POLICY IF EXISTS operator_oauth_client_read ON operator_oauth_client;
CREATE POLICY operator_oauth_client_read ON operator_oauth_client FOR SELECT
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

CREATE OR REPLACE FUNCTION caelo_operator_oauth_writer() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT current_setting('caelo.actor_kind', true) = 'system'
      OR (current_setting('caelo.actor_kind', true) = 'human' AND EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id::text = current_setting('caelo.actor_id', true)
          AND p.name = 'settings.write'
      ))
  $$;

DROP POLICY IF EXISTS operator_oauth_client_insert ON operator_oauth_client;
CREATE POLICY operator_oauth_client_insert ON operator_oauth_client FOR INSERT
  WITH CHECK (caelo_operator_oauth_writer());
DROP POLICY IF EXISTS operator_oauth_client_update ON operator_oauth_client;
CREATE POLICY operator_oauth_client_update ON operator_oauth_client FOR UPDATE
  USING (caelo_operator_oauth_writer()) WITH CHECK (caelo_operator_oauth_writer());
DROP POLICY IF EXISTS operator_oauth_client_delete ON operator_oauth_client;
CREATE POLICY operator_oauth_client_delete ON operator_oauth_client FOR DELETE
  USING (caelo_operator_oauth_writer());
