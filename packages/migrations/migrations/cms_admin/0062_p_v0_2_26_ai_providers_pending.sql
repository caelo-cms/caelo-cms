-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.26 — ai_providers_pending_actions: AI-proposed AI provider
-- config changes (set / clear_key) queued for Owner approval.
--
-- Same shape as email_config_pending (v0.2.25) and reuses the
-- Owner-supplies-secret-at-approve pattern: AI never writes API key
-- material to the proposal; the Owner pastes the apiKey inline at
-- approve time and execute_proposal merges it into the underlying
-- ai_providers.set call.

CREATE TABLE IF NOT EXISTS ai_providers_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('set', 'clear_key')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  -- Provider name is part of every proposal (set + clear_key both
  -- target a specific provider). Stored at the column level for
  -- cheap filtering even though it also appears in payload.
  provider_name   text NOT NULL,
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL
);

CREATE INDEX IF NOT EXISTS ai_providers_pending_actions_status_idx
  ON ai_providers_pending_actions (status, created_at DESC);

ALTER TABLE ai_providers_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_providers_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_providers_pending_actions_authenticated_scope ON ai_providers_pending_actions;
CREATE POLICY ai_providers_pending_actions_authenticated_scope ON ai_providers_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
