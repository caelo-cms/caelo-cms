-- SPDX-License-Identifier: MPL-2.0
--
-- 0254 — issue #658: hand approval decisions back to the external agent
-- that asked for them.
--
-- A Power-MCP caller (admin-scoped MCP token, #376) that calls an
-- approval-gated tool queues an ordinary §11.A proposal in its domain's
-- pending table, tagged with the MCP work session's chat_session_id. That
-- session is usually the operator's own Live Edit chat (#620 resumes it),
-- so the proposal shows up there — and nothing told the chat that the
-- proposal was NOT its own AI's: Approve auto-continued the Live Edit AI,
-- while the external agent never learned the decision.
--
-- One row here per MCP-originated proposal records its origin (channel,
-- session, requesting actor, tool, the caller's tool call id) and mirrors
-- the decision once the operator made it, so:
--   * the Live Edit card can say "requested by the external agent" and
--     must not start a Live Edit AI turn on Approve;
--   * mcp.get_approval_outcome can hand the decision back to the caller
--     (delivered_at records that it did).
--
-- Keyed by proposal id across all pending domains (ids are uuids, unique
-- per table and practically across them; `domain` disambiguates the
-- lookup). The proposal row itself stays the source of truth for the
-- decision — outcome/decided_at here are a mirror written when the
-- decision is first observed.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE mcp_approval_handoffs (
  proposal_id      uuid PRIMARY KEY,
  -- pending_proposals.list domain ('layouts', 'tool_approvals', 'mcp_tokens', …).
  domain           text NOT NULL CHECK (domain ~ '^[a-z_]{1,64}$'),
  -- Which external surface asked. Only the Power-MCP queues proposals
  -- from outside today; caelo_chat pauses its own chat turn instead.
  channel          text NOT NULL DEFAULT 'power_mcp' CHECK (channel IN ('power_mcp')),
  chat_session_id  uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  requested_by     uuid NOT NULL REFERENCES actors(id),
  tool_name        text NOT NULL,
  tool_call_id     text NOT NULL,
  summary          text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  outcome          text NULL
                   CHECK (outcome IN ('applied', 'failed', 'rejected', 'superseded', 'withdrawn')),
  outcome_detail   text NULL,
  decided_at       timestamptz NULL,
  -- First time the external agent read the decided outcome.
  delivered_at     timestamptz NULL
);

CREATE INDEX mcp_approval_handoffs_session_idx
  ON mcp_approval_handoffs (chat_session_id, created_at DESC);

ALTER TABLE mcp_approval_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_approval_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_approval_handoffs_authenticated_scope ON mcp_approval_handoffs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
