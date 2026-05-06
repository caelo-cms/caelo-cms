-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.23 — snapshot_revert_pending_actions: AI-proposed snapshot
-- reverts (site / page / template / module) queued for Owner approval.
--
-- Same shape as deploy_pending (v0.2.19), layout_pending (v0.2.20),
-- user_pending (v0.2.21), role_pending (v0.2.22).
--
-- Highest-blast-radius surface in the propose/execute sweep — one click
-- rewinds hours of editor work, possibly across the entire site. The
-- preview computes the affected entity counts (modules / pages /
-- templates / page_layouts present in the target snapshot) so the
-- Owner sees the rewind size before approving. revert_module is small
-- (one row); revert_site can touch hundreds.

CREATE TABLE IF NOT EXISTS snapshot_revert_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('site', 'page', 'template', 'module')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  -- Target snapshot id is required for every kind. The entity_id is
  -- NULL for kind='site' and the corresponding entity for the other
  -- three. We store entity_id as a generic uuid (no FK) because the
  -- referenced entity may itself have been deleted between propose
  -- and execute — the snapshot still has its state.
  snapshot_id     uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  entity_id       uuid NULL,
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL,
  applied_snapshot_id uuid NULL REFERENCES site_snapshots(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS snapshot_revert_pending_actions_status_idx
  ON snapshot_revert_pending_actions (status, created_at DESC);

ALTER TABLE snapshot_revert_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshot_revert_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS snapshot_revert_pending_actions_authenticated_scope ON snapshot_revert_pending_actions;
CREATE POLICY snapshot_revert_pending_actions_authenticated_scope ON snapshot_revert_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
