-- SPDX-License-Identifier: MPL-2.0
--
-- 0481 — the work session a remote MCP connection opened without a
-- transport session (#1306).
--
-- caelo_open_session binds the agent's work session to the request's
-- `Mcp-Session-Id` (0453). A client that sends no such header (one
-- connected before 0.11.6 keeps none) got a successful open, and its next
-- call without `workSessionId` was told "call caelo_open_session first" —
-- so it opened again, and again. This table remembers the session such a
-- connection opened last, so that refusal can say "you opened <id>, but
-- this connection cannot carry it: pass workSessionId" instead.
--
-- One row per connection (the newest open wins). No foreign key to
-- chat_sessions, for the reason 0453 gives: the content reset truncates
-- chat_sessions with CASCADE, and a stale id is answered "session not
-- found" like any other.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS mcp_unbound_work_sessions (
  connection_id    uuid PRIMARY KEY REFERENCES mcp_remote_connections(id) ON DELETE CASCADE,
  chat_session_id  uuid NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mcp_unbound_work_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_unbound_work_sessions FORCE ROW LEVEL SECURITY;
-- The same scope as mcp_transport_sessions: the Power-MCP steps read and
-- write it as the connection's own user, the system sees everything, and
-- nobody reaches another user's row.
DROP POLICY IF EXISTS mcp_unbound_work_sessions_own ON mcp_unbound_work_sessions;
CREATE POLICY mcp_unbound_work_sessions_own ON mcp_unbound_work_sessions
  USING (caelo_setting_is('caelo.actor_kind', 'system')
    OR (caelo_setting_is('caelo.actor_kind', 'human')
        AND EXISTS (SELECT 1 FROM mcp_remote_connections c
                    WHERE c.id = connection_id AND c.actor_id = caelo_mcp_token_principal())))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system')
    OR (caelo_setting_is('caelo.actor_kind', 'human')
        AND EXISTS (SELECT 1 FROM mcp_remote_connections c
                    WHERE c.id = connection_id AND c.actor_id = caelo_mcp_token_principal())));

COMMIT;
