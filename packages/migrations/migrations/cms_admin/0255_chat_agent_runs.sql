-- SPDX-License-Identifier: MPL-2.0
--
-- 0255 — issues #664 / #665: one source of truth for the AI work running in
-- a chat, so the operator can see it and stop it.
--
-- Stop in the Live Edit chat used to be a client-side fetch abort. Behind
-- Cloud Run the server never saw it: the turn ran on for minutes, and the
-- auto-sent messages queued behind it (quality fix rounds, "Approved …
-- please continue") started more turns. At the same time an external
-- Power-MCP agent wrote to the same chat with nothing in the UI saying so.
--
-- `chat_agent_runs` holds one row per running unit of AI work in a chat:
--   * kind 'turn'     — a chat-runner turn (Live Edit or caelo_chat), from
--                       the moment it arrives (state 'queued', waiting for
--                       the chat's turn lease, 0247) until it ends
--                       ('running' in between). The runner renews the row
--                       every second and reads `cancel_requested_at` back:
--                       that is how Stop reaches a turn on ANY instance.
--   * kind 'subagent' — a child turn spawned by a turn (`parent_run_id`).
--   * kind 'mcp'      — an external Power-MCP agent working in the chat; one
--                       row per (chat, token), pushed forward on every tool
--                       call. While it is fresh, a Live Edit turn does not
--                       start (one agent per chat at a time). Stopping it
--                       turns the row into state 'stopped', which refuses
--                       the agent's calls in this chat until the operator
--                       clicks "Allow again" (the row is then deleted).
-- Finished turns and subagents delete their row; a crashed instance stops
-- renewing and the row expires (judged on the database clock, like 0247).
--
-- `chat_sessions.agents_stopped_at` is the chat-level Stop latch: set by a
-- Stop, it refuses every turn that is not an operator's own message (auto
-- nudges from any tab, caelo_chat), and the operator's next message clears
-- it — "nothing restarts the AI until I say so". `agents_stop_epoch` counts
-- the Stops: a request reads it when it ARRIVES and is refused if a Stop
-- happened before it registered, so a message sent just before Stop (still
-- resolving its provider when Stop landed) cannot slip through afterwards.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE chat_agent_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_session_id      uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('turn', 'subagent', 'mcp')),
  -- Who started it: the Live Edit chat, an external agent via caelo_chat,
  -- the Power-MCP tool surface, or a parent turn (subagent).
  source               text NOT NULL
                       CHECK (source IN ('live_edit', 'mcp_chat', 'power_mcp', 'subagent')),
  label                text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  state                text NOT NULL CHECK (state IN ('queued', 'running', 'stopped')),
  started_by           uuid NULL REFERENCES actors(id) ON DELETE SET NULL,
  mcp_token_id         uuid NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  parent_run_id        uuid NULL REFERENCES chat_agent_runs(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  heartbeat_at         timestamptz NOT NULL DEFAULT now(),
  -- NULL only for a stopped external agent: the block holds until the
  -- operator lifts it, never by timing out.
  expires_at           timestamptz NULL,
  cancel_requested_at  timestamptz NULL,
  cancel_requested_by  uuid NULL REFERENCES actors(id) ON DELETE SET NULL,
  CHECK ((kind = 'mcp') = (mcp_token_id IS NOT NULL)),
  CHECK ((kind = 'subagent') = (parent_run_id IS NOT NULL)),
  CHECK (expires_at IS NOT NULL OR (kind = 'mcp' AND state = 'stopped'))
);

-- One external-agent row per (chat, token); NULL token ids (turns,
-- subagents) never collide.
CREATE UNIQUE INDEX chat_agent_runs_mcp_uniq ON chat_agent_runs (chat_session_id, mcp_token_id);
CREATE INDEX chat_agent_runs_session_idx ON chat_agent_runs (chat_session_id, created_at);
CREATE INDEX chat_agent_runs_parent_idx ON chat_agent_runs (parent_run_id)
  WHERE parent_run_id IS NOT NULL;

ALTER TABLE chat_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_agent_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_agent_runs_authenticated_scope ON chat_agent_runs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE chat_sessions ADD COLUMN agents_stopped_at timestamptz NULL;
ALTER TABLE chat_sessions ADD COLUMN agents_stop_epoch integer NOT NULL DEFAULT 0;

COMMIT;
