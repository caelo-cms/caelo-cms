-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.30 — domain_pending_actions: AI-proposed domain registry
-- changes (add / remove) queued for Owner approval.
--
-- Same shape as user_pending (v0.2.21). domains.list + domains.verify
-- are AI-open (read + diagnostic); set_tls_status stays system-only
-- (Caddy webhook). This gate covers the registry mutations that
-- cascade to cms-provision regenerate-caddy.

CREATE TABLE IF NOT EXISTS domain_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('add', 'remove')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  -- Target domain id is required for remove; NULL for add (no row yet).
  domain_id       uuid NULL REFERENCES domains(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL,
  applied_domain_id uuid NULL REFERENCES domains(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS domain_pending_actions_status_idx
  ON domain_pending_actions (status, created_at DESC);

ALTER TABLE domain_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS domain_pending_actions_authenticated_scope ON domain_pending_actions;
CREATE POLICY domain_pending_actions_authenticated_scope ON domain_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
