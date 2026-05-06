-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.22 — role_pending_actions: AI-proposed role lifecycle changes
-- (create / update_permissions / delete) queued for Owner approval.
--
-- Same shape as deploy_pending (v0.2.19), layout_pending (v0.2.20),
-- user_pending (v0.2.21). Security domain — AI proposes "create an
-- 'analyst' role with read-only access" or "grant deploy.promote to
-- the editor role"; Owner clicks Approve at /security/roles/pending
-- to actually mutate the permission perimeter.

CREATE TABLE IF NOT EXISTS role_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('create', 'update_permissions', 'delete')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  -- Target role id (NULL for create — there's no row yet).
  role_id         uuid NULL REFERENCES roles(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL,
  applied_role_id uuid NULL REFERENCES roles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS role_pending_actions_status_idx
  ON role_pending_actions (status, created_at DESC);

ALTER TABLE role_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_pending_actions_authenticated_scope ON role_pending_actions;
CREATE POLICY role_pending_actions_authenticated_scope ON role_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
