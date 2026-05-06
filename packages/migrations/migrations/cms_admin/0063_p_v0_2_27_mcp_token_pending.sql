-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.27 — mcp_token_pending_actions: AI-proposed MCP token lifecycle
-- changes (create / revoke) queued for Owner approval.
--
-- Same shape as ai_providers_pending (v0.2.26) and user_pending
-- (v0.2.21). Token plaintext is generated server-side at execute time
-- and returned ONCE in the form-action response — never stored in
-- the proposal payload, never logged in the audit trail.

CREATE TABLE IF NOT EXISTS mcp_token_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('create', 'revoke')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  -- Target token id is required for revoke; NULL for create (no row yet).
  token_id        uuid NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL,
  applied_token_id uuid NULL REFERENCES mcp_tokens(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS mcp_token_pending_actions_status_idx
  ON mcp_token_pending_actions (status, created_at DESC);

ALTER TABLE mcp_token_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_token_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcp_token_pending_actions_authenticated_scope ON mcp_token_pending_actions;
CREATE POLICY mcp_token_pending_actions_authenticated_scope ON mcp_token_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
