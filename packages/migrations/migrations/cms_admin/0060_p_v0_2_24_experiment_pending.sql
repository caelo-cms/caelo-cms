-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.24 — experiment_pending_actions: AI-proposed experiment lifecycle
-- changes (activate / complete) queued for Owner approval.
--
-- Same shape as snapshot_revert_pending (v0.2.23) and role_pending
-- (v0.2.22). experiments.create is already AI-open per CLAUDE.md §11
-- ("default actorScope is human + ai + system"); only the lifecycle
-- transitions that flip a live experiment on or off go through the
-- propose/execute gate.

CREATE TABLE IF NOT EXISTS experiment_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('activate', 'complete')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  experiment_id   uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL
);

CREATE INDEX IF NOT EXISTS experiment_pending_actions_status_idx
  ON experiment_pending_actions (status, created_at DESC);

ALTER TABLE experiment_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS experiment_pending_actions_authenticated_scope ON experiment_pending_actions;
CREATE POLICY experiment_pending_actions_authenticated_scope ON experiment_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
