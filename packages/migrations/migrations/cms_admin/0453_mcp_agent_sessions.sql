-- SPDX-License-Identifier: MPL-2.0
--
-- 0453 — issue #1253: one work session per external agent.
--
-- Until now a remote MCP connection kept ONE "current work session" on its
-- row (`mcp_remote_connections.current_chat_session_id`, 0319), and
-- caelo_open_session without arguments resumed the user's most recent open
-- chat. Every agent of one client therefore shared one chat — Undo, Stop
-- and presence were shared, their writes never conflicted with each other
-- (lost updates were silent), and an agent could land in the operator's
-- own Live Edit chat. searchVIU production, 2026-10-29: five translation
-- agents over one Claude Code connection wrote one at a time.
--
-- Now:
--
--   - `mcp_transport_sessions` keys an agent's current work session by the
--     MCP transport session (`Mcp-Session-Id`, minted by the admin on
--     `initialize`) of its connection. An explicit `workSessionId` on a
--     tool call wins over it, which is how several agents sharing one
--     transport (sub-agents of one client) each keep their own chat.
--     Scoped to the connection row, so a forged header can only name one of
--     the caller's own mappings. No foreign key to chat_sessions on
--     purpose (same reason as 0319): the content reset truncates
--     chat_sessions with CASCADE, and a stale id is answered "session not
--     found" like any other.
--   - `chat_sessions.agent_client` names the client app a chat was opened
--     for by an external agent ("Claude Code", a token's label). Non-null
--     marks an agent chat: the chat list groups them per client, and Live
--     Edit never picks one as the operator's chat.
--   - the connection row's `current_chat_session_id` is no longer read or
--     written by this release. It stays (expand-only): the previous
--     release's images still read and write it while the roll runs. Its
--     DROP is the contract half, shipped in a later release with
--     `caelo:requires-earlier-run 0453_mcp_agent_sessions.sql`.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS mcp_transport_sessions (
  connection_id         uuid NOT NULL REFERENCES mcp_remote_connections(id) ON DELETE CASCADE,
  transport_session_id  text NOT NULL CHECK (char_length(transport_session_id) BETWEEN 16 AND 128),
  chat_session_id       uuid NOT NULL,
  -- Written when caelo_open_session (re)binds the transport session, never
  -- per tool call: the garbage collection keys on it.
  bound_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, transport_session_id)
);

ALTER TABLE mcp_transport_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_transport_sessions FORCE ROW LEVEL SECURITY;
-- Request-time plumbing of the remote MCP route: the Power-MCP ops read and
-- bind it acting as the connection's own user (the human session the
-- agent's calls run under), the system resolver sees everything. An AI
-- session never touches it, and nobody reaches another user's mapping.
DROP POLICY IF EXISTS mcp_transport_sessions_own ON mcp_transport_sessions;
CREATE POLICY mcp_transport_sessions_own ON mcp_transport_sessions
  USING (current_setting('caelo.actor_kind', true) = 'system'
    OR (current_setting('caelo.actor_kind', true) = 'human'
        AND EXISTS (SELECT 1 FROM mcp_remote_connections c
                    WHERE c.id = connection_id AND c.actor_id = caelo_mcp_token_principal())))
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system'
    OR (current_setting('caelo.actor_kind', true) = 'human'
        AND EXISTS (SELECT 1 FROM mcp_remote_connections c
                    WHERE c.id = connection_id AND c.actor_id = caelo_mcp_token_principal())));

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS agent_client text NULL
    CHECK (agent_client IS NULL OR char_length(agent_client) BETWEEN 1 AND 200);


COMMIT;
