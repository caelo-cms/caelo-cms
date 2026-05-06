-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.25 — email_config_pending_actions: AI-proposed email transport
-- changes queued for Owner approval.
--
-- Same shape as experiment_pending (v0.2.24), but introduces a new
-- pattern: the AI's proposal payload NEVER contains the transport
-- secret (smtp password, resend apiKey). The Owner supplies the secret
-- inline at approve time via the form action; execute_proposal merges
-- it into the config and applies. AI never sees credential material.

CREATE TABLE IF NOT EXISTS email_config_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  -- payload contains transport + fromAddress + config-without-secrets.
  payload         jsonb NOT NULL,
  -- preview is what the Owner UI renders; same as payload for this
  -- domain since there's no per-row blast-radius computation needed.
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL
);

CREATE INDEX IF NOT EXISTS email_config_pending_actions_status_idx
  ON email_config_pending_actions (status, created_at DESC);

ALTER TABLE email_config_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_config_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_config_pending_actions_authenticated_scope ON email_config_pending_actions;
CREATE POLICY email_config_pending_actions_authenticated_scope ON email_config_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
