-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.28 — template_pending_actions: AI-proposed template lifecycle
-- changes (update / delete) queued for Owner approval.
--
-- Same shape as role_pending (v0.2.22). templates.create + set_layout
-- are already AI-direct; this gate covers update (HTML/CSS/displayName
-- changes that affect every bound page's render) and delete (which
-- orphans every bound page).

CREATE TABLE IF NOT EXISTS template_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('update', 'delete')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  template_id     uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL
);

CREATE INDEX IF NOT EXISTS template_pending_actions_status_idx
  ON template_pending_actions (status, created_at DESC);

ALTER TABLE template_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS template_pending_actions_authenticated_scope ON template_pending_actions;
CREATE POLICY template_pending_actions_authenticated_scope ON template_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
