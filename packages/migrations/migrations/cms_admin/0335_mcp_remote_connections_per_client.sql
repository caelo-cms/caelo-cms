-- SPDX-License-Identifier: MPL-2.0
-- caelo:contract the previous image inserts remote connections with ON CONFLICT (actor_id, surface), whose unique constraint this migration replaces by (actor_id, surface, client_key)
--
-- 0335 — issue #968: one remote MCP connection per client app.
--
-- 0319 kept one row per (user, surface); `client_label` only named the last
-- app that used it. Revoking "Claude Code" therefore also locked out the
-- same user's ChatGPT, which then failed tool discovery with nothing to say
-- why. A row is now one (user, surface, client app):
--
--   - `client_key` is the app's identity from the gateway's OAuth broker
--     (apps/api-gateway/src/mcp/access-token.ts `mcpClientKey`): the CIMD
--     document URL, or `dcr:<client_name>` for a dynamically registered
--     client. The broker seals it into the access token and forwards it;
--     revoke, restore, the cost cap and the Power-MCP work session are per
--     app from here on.
--   - NULL marks a row from before this migration. The admin hands it to
--     the first app whose MCP `initialize` names the row's `client_label`
--     (mcp_principal.ts), so an existing connection keeps its revocation,
--     cap and work session and becomes "the row of its last client". An
--     app with a different name gets a row of its own.
--   - `revoked_by` lets a refused client say who revoked it.
--
-- `mcp_remote_access_blocks` is the Owner's "all apps of this user" switch:
-- a blocked user's every remote request is refused, including apps that
-- never connected before. A per-app revoke alone cannot do that, because
-- registering a client is open to anyone and a new app name would be a new
-- row.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE mcp_remote_connections
  ADD COLUMN client_key text NULL
    CHECK (client_key IS NULL OR char_length(client_key) BETWEEN 1 AND 200),
  ADD COLUMN revoked_by uuid NULL REFERENCES actors(id) ON DELETE SET NULL;

ALTER TABLE mcp_remote_connections DROP CONSTRAINT mcp_remote_connections_actor_id_surface_key;
CREATE UNIQUE INDEX mcp_remote_connections_client_uniq
  ON mcp_remote_connections (actor_id, surface, client_key);
-- At most one pre-#968 row per (user, surface), as before: the adoption
-- rule hands out exactly that one.
CREATE UNIQUE INDEX mcp_remote_connections_legacy_uniq
  ON mcp_remote_connections (actor_id, surface) WHERE client_key IS NULL;

CREATE TABLE mcp_remote_access_blocks (
  actor_id    uuid PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  blocked_at  timestamptz NOT NULL DEFAULT now(),
  blocked_by  uuid NULL REFERENCES actors(id) ON DELETE SET NULL
);

ALTER TABLE mcp_remote_access_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_remote_access_blocks FORCE ROW LEVEL SECURITY;
-- Same rule as mcp_remote_connections (0322): an Owner and system see every
-- block, a user only their own; only a human Owner or system sets or lifts
-- one. The AI never writes here.
CREATE POLICY mcp_remote_access_blocks_read ON mcp_remote_access_blocks FOR SELECT
  USING (caelo_mcp_tokens_manage_all() OR actor_id = caelo_mcp_token_principal());
CREATE POLICY mcp_remote_access_blocks_insert ON mcp_remote_access_blocks FOR INSERT
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'system')
    AND caelo_mcp_tokens_manage_all());
CREATE POLICY mcp_remote_access_blocks_delete ON mcp_remote_access_blocks FOR DELETE
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'system')
    AND caelo_mcp_tokens_manage_all());

COMMIT;
