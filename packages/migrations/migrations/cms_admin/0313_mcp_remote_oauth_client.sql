-- SPDX-License-Identifier: MPL-2.0
--
-- 0313 — issue #806: which Google OAuth client remote MCP uses.
--
-- Remote MCP (ChatGPT, claude.ai, HTTP-capable MCP clients) signs users in
-- with a Google OAuth client the Owner creates in the Google console and
-- pastes under Settings → MCP → Remote. The client SECRET never touches the
-- database: the admin writes `{client_id, client_secret}` straight into the
-- Secret Manager secret the gateway's broker reads (add-version only; the
-- admin cannot read it back). This table keeps only the client ID, for two
-- readers:
--
--   * the operator-access sync job, which makes the admin IAP resource's
--     `programmatic_clients` hold exactly this client (or nothing when no
--     row exists) — reading it with its read-only role (0314);
--   * the setup page, which shows the configured client and checks that the
--     gateway serves the same one (by SHA-256, the gateway never echoes it).
--
-- At most one row (`id` is always true). No row = remote MCP not set up.

CREATE TABLE IF NOT EXISTS mcp_remote_oauth_client (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- A Google OAuth 2.0 client ID: `<project number>-<random>.apps.googleusercontent.com`.
  client_id     text NOT NULL
                CHECK (client_id ~ '^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$'),
  configured_by uuid NOT NULL REFERENCES actors(id),
  configured_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mcp_remote_oauth_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_remote_oauth_client FORCE ROW LEVEL SECURITY;

-- Any authenticated session may read (the client ID is not a secret: it is
-- in every Google sign-in URL); only humans and system write, matching the
-- human/system op scope.
DROP POLICY IF EXISTS mcp_remote_oauth_client_authenticated_scope ON mcp_remote_oauth_client;
CREATE POLICY mcp_remote_oauth_client_authenticated_scope ON mcp_remote_oauth_client
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'system'));
