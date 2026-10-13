-- SPDX-License-Identifier: MPL-2.0
--
-- 0258 — issue #658 (remaining gap): every in-chat approval a chat turn
-- paused on, with who is waiting for it.
--
-- A gated tool pauses the chat-runner turn on an AI SDK
-- tool-approval-request (CLAUDE.md §11.A, Plan B). The request only ever
-- travelled as an SSE event to the tab that ran the turn, so:
--   * a turn run by an external agent through `caelo_chat` (chat-scoped
--     MCP token) paused on a card that neither the MCP response nor the
--     operator's Live Edit chat showed — nobody could approve it;
--   * a reloaded Live Edit chat lost its own paused card too.
--
-- One row per approval request records the paused turn's source:
--   * 'live_edit' — the Live Edit chat's own AI. Its card resumes that
--     turn from the chat (the operator's Approve/Reject IS the go-ahead,
--     also after a Stop).
--   * 'mcp_chat'  — an external agent via caelo_chat. The Live Edit card
--     only records the decision (it must not start a Live Edit AI turn);
--     the external agent's own call resumes its turn and receives the
--     result.
--
-- Lifecycle: pending → approved | rejected (decided) → resumed (the turn
-- that applies the decision claimed it). A pending or decided-unresumed
-- row becomes 'superseded' when another message moves the chat on — the
-- chat-runner's history repair answers the unanswered call as interrupted
-- from then on, so the card is dead.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE chat_turn_approvals (
  chat_session_id       uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  -- The SDK's approval id (the tool-approval-request / -response pair key).
  approval_id           text NOT NULL CHECK (char_length(approval_id) BETWEEN 1 AND 200),
  source                text NOT NULL CHECK (source IN ('live_edit', 'mcp_chat')),
  -- caelo_chat: the token whose turn paused. Only that token resumes it.
  mcp_token_id          uuid NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  tool_call_id          text NOT NULL,
  tool_name             text NOT NULL,
  preview               text NOT NULL,
  -- #589 — permissions whoever decides must hold.
  required_permissions  text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'resumed', 'superseded')),
  -- The decision; kept when the row moves on to 'resumed'.
  approved              boolean NULL,
  reason                text NULL,
  decided_by            uuid NULL REFERENCES actors(id) ON DELETE SET NULL,
  decided_at            timestamptz NULL,
  resumed_at            timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_session_id, approval_id),
  CHECK ((source = 'mcp_chat') = (mcp_token_id IS NOT NULL)),
  CHECK ((status IN ('approved', 'rejected')) <= (approved IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK ((status = 'resumed') <= (resumed_at IS NOT NULL))
);

CREATE INDEX chat_turn_approvals_open_idx
  ON chat_turn_approvals (chat_session_id, created_at)
  WHERE status IN ('pending', 'approved', 'rejected');

ALTER TABLE chat_turn_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_turn_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_turn_approvals_authenticated_scope ON chat_turn_approvals
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
