-- SPDX-License-Identifier: MPL-2.0
--
-- #393 (epic #380) — plugin lifecycle completion.
--
-- 1. skills.plugin_id: plugin-SHIPPED skills (manifest `skills[]`) are
--    registered at activation as awaiting_activation and archived on
--    uninstall — the column records ownership so uninstall knows what
--    to archive. ON DELETE SET NULL keeps an Owner-activated skill's
--    row (archived) even after its plugin row is gone, mirroring the
--    actors FK: history survives, the live surface doesn't.
--
-- 2. plugin_pending_actions: the §11.A pending table for the gated
--    uninstall (propose_uninstall → execute_proposal). Uninstall DROPS
--    both plugin schemas — data loss is the point and the preview says
--    so — which is exactly the hard-to-revert class the gate exists
--    for. Canonical shape per 0055.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE skills ADD COLUMN IF NOT EXISTS plugin_id uuid NULL REFERENCES plugins(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS skills_plugin_id_idx ON skills (plugin_id) WHERE plugin_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS plugin_pending_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('uninstall')),
  proposed_by      uuid NOT NULL REFERENCES actors(id),
  plugin_id        uuid NULL REFERENCES plugins(id) ON DELETE CASCADE,
  payload          jsonb NOT NULL,
  preview          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  chat_session_id  uuid NULL,
  payload_hash     text NOT NULL,
  decided_by       uuid NULL REFERENCES actors(id),
  decided_at       timestamptz NULL,
  decision_reason  text NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_pending_actions_payload_hash_pending_uniq
  ON plugin_pending_actions (payload_hash)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS plugin_pending_actions_status_idx
  ON plugin_pending_actions (status, created_at);

ALTER TABLE plugin_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_pending_actions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plugin_pending_actions_rw ON plugin_pending_actions;
CREATE POLICY plugin_pending_actions_rw ON plugin_pending_actions
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'))
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'));

GRANT SELECT, INSERT, UPDATE, DELETE ON plugin_pending_actions TO admin_role;

COMMIT;
