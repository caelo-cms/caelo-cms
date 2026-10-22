-- SPDX-License-Identifier: MPL-2.0
--
-- 0319 — issue #806: remote MCP connections.
--
-- A remote MCP client (claude.ai, ChatGPT, Claude Code over HTTP, …) reaches
-- the admin through Google IAP with the user's own Google identity; there is
-- no bearer token to mint or paste. The admin verifies IAP's signed
-- assertion, maps its email to a Caelo user, and keeps ONE row here per
-- (user, surface). The row is what an Owner sees and controls under
-- Settings → MCP: revoke (sticky — a later request never resurrects it),
-- restore, the AI cost cap and, on the admin surface, whether the agent may
-- spend the install's own AI. It is the remote twin of an `mcp_tokens` row
-- and plays the same role in attribution (running agents, paused approvals).
--
-- `current_chat_session_id` is the Power-MCP "current work session": the
-- remote transport is stateless (Cloud Run scales horizontally, a request
-- may land on any instance), so caelo_open_session persists the session here
-- instead of in process memory like the stdio shim does.

CREATE TABLE mcp_remote_connections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id                 uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  surface                  text NOT NULL CHECK (surface IN ('chat', 'admin')),
  -- NULL = uncapped. Microcents (USD × 1e8) — same units as ai_calls.
  ai_cost_cap_microcents   bigint NULL CHECK (ai_cost_cap_microcents IS NULL OR ai_cost_cap_microcents >= 0),
  -- #741 semantics: only meaningful on the admin surface (a chat connection
  -- always runs Caelo's own agent), so it can only be true there.
  allow_caelo_ai           boolean NOT NULL DEFAULT false,
  -- Deliberately NO foreign key to chat_sessions: the content reset
  -- (migrations/src/truncate.ts) runs `TRUNCATE chat_sessions … CASCADE`,
  -- which empties every table referencing it — an FK here would wipe the
  -- Owner's revocations and caps with the chats. A stale id is harmless:
  -- every use goes through chat.get_session, which reports it missing and
  -- the agent opens a new session.
  current_chat_session_id  uuid NULL,
  -- The client's self-reported name (MCP initialize clientInfo), for the UI.
  client_label             text NULL CHECK (client_label IS NULL OR char_length(client_label) BETWEEN 1 AND 200),
  created_at               timestamptz NOT NULL DEFAULT now(),
  last_used_at             timestamptz NULL,
  revoked_at               timestamptz NULL,
  UNIQUE (actor_id, surface),
  CHECK (allow_caelo_ai = false OR surface = 'admin')
);

ALTER TABLE mcp_remote_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_remote_connections FORCE ROW LEVEL SECURITY;
-- Same policy as mcp_tokens: readable by any authenticated session, writable
-- by humans (the Owner's settings) and the system (request-time resolution).
CREATE POLICY mcp_remote_connections_authenticated_scope ON mcp_remote_connections
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'system'));

-- Attribution: an external agent is a token OR a remote connection. The
-- running-agents row of a Power-MCP agent (0255) and the approval cards a
-- caelo_chat turn paused on (0258) name exactly one of them.
ALTER TABLE chat_agent_runs
  ADD COLUMN mcp_remote_connection_id uuid NULL
    REFERENCES mcp_remote_connections(id) ON DELETE CASCADE;
ALTER TABLE chat_agent_runs DROP CONSTRAINT chat_agent_runs_check;
ALTER TABLE chat_agent_runs ADD CONSTRAINT chat_agent_runs_mcp_agent_check
  CHECK ((kind = 'mcp') = (num_nonnulls(mcp_token_id, mcp_remote_connection_id) = 1)
         AND num_nonnulls(mcp_token_id, mcp_remote_connection_id) <= 1);
-- One external-agent row per (chat, remote connection), like per (chat, token).
CREATE UNIQUE INDEX chat_agent_runs_mcp_remote_uniq
  ON chat_agent_runs (chat_session_id, mcp_remote_connection_id);

ALTER TABLE chat_turn_approvals
  ADD COLUMN mcp_remote_connection_id uuid NULL
    REFERENCES mcp_remote_connections(id) ON DELETE CASCADE;
ALTER TABLE chat_turn_approvals DROP CONSTRAINT chat_turn_approvals_check;
ALTER TABLE chat_turn_approvals ADD CONSTRAINT chat_turn_approvals_mcp_agent_check
  CHECK ((source = 'mcp_chat') = (num_nonnulls(mcp_token_id, mcp_remote_connection_id) = 1)
         AND num_nonnulls(mcp_token_id, mcp_remote_connection_id) <= 1);
