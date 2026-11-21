-- SPDX-License-Identifier: MPL-2.0
--
-- Epic #1644 (R6, issue #1645) — the §11.A queue of plugin configuration.
--
-- A plugin's configuration lives in host-owned tables of its own schema
-- (caelo_config, caelo_entity_config; plugin-host/src/plugin-config.ts),
-- provisioned with the plugin, not here. A field the plugin declares with
-- `gate: "approval"` (a cost limit, say) changes only through this queue:
-- the AI proposes, a human holding settings.write approves in the chat, and
-- the approved value is written on main, where the next Stage freezes it.
--
-- Expand-only: a new table the previous release does not read.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE plugin_config_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('update')),
  plugin_id       uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  decided_by      uuid REFERENCES actors(id),
  decision_reason text,
  chat_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  payload_hash    text
);
CREATE UNIQUE INDEX plugin_config_pending_actions_payload_hash_pending_uniq
  ON plugin_config_pending_actions (payload_hash)
  WHERE status = 'pending' AND payload_hash IS NOT NULL;
CREATE INDEX plugin_config_pending_actions_status_idx
  ON plugin_config_pending_actions (status, created_at DESC);
CREATE INDEX plugin_config_pending_actions_plugin_idx
  ON plugin_config_pending_actions (plugin_id);
CREATE INDEX plugin_config_pending_actions_proposed_by_idx
  ON plugin_config_pending_actions (proposed_by);
CREATE INDEX plugin_config_pending_actions_decided_by_idx
  ON plugin_config_pending_actions (decided_by);
CREATE INDEX plugin_config_pending_actions_chat_session_idx
  ON plugin_config_pending_actions (chat_session_id);

ALTER TABLE plugin_config_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_config_pending_actions FORCE ROW LEVEL SECURITY;
-- Any authenticated actor session; who may write what is decided at the op.
CREATE POLICY plugin_config_pending_actions_authenticated_scope ON plugin_config_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
