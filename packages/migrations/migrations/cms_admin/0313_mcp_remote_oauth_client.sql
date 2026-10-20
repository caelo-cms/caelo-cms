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
-- in every Google sign-in URL). Writes decide which OAuth client Google IAP
-- accepts programmatically, so they are system or a human Owner
-- (settings.write) — at the Postgres layer, not only in the route guard
-- (CLAUDE.md §2; the same rule 0315 applies to mcp_tokens). The AI never
-- writes here. `caelo.actor_id` is compared as text so a malformed id
-- matches nobody instead of failing the cast.
DROP POLICY IF EXISTS mcp_remote_oauth_client_authenticated_scope ON mcp_remote_oauth_client;
CREATE POLICY mcp_remote_oauth_client_read ON mcp_remote_oauth_client FOR SELECT
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

CREATE FUNCTION caelo_mcp_remote_oauth_writer() RETURNS boolean
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

CREATE POLICY mcp_remote_oauth_client_insert ON mcp_remote_oauth_client FOR INSERT
  WITH CHECK (caelo_mcp_remote_oauth_writer());
CREATE POLICY mcp_remote_oauth_client_update ON mcp_remote_oauth_client FOR UPDATE
  USING (caelo_mcp_remote_oauth_writer()) WITH CHECK (caelo_mcp_remote_oauth_writer());
CREATE POLICY mcp_remote_oauth_client_delete ON mcp_remote_oauth_client FOR DELETE
  USING (caelo_mcp_remote_oauth_writer());
