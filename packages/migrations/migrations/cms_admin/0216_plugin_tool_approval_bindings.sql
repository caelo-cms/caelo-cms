-- SPDX-License-Identifier: MPL-2.0
-- Host-only bindings for SDK approval requests. A resumed tool call must still
-- target the exact installation, capability receipts, arguments and author.
CREATE TABLE plugin_tool_approval_bindings (
  plugin_id uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  chat_branch_id uuid NOT NULL,
  tool_call_id text NOT NULL CHECK (length(tool_call_id) BETWEEN 1 AND 256),
  operator_actor_id uuid NOT NULL REFERENCES actors(id),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, chat_branch_id, tool_call_id)
);
ALTER TABLE plugin_tool_approval_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_tool_approval_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_tool_binding_read ON plugin_tool_approval_bindings FOR SELECT
  USING (current_setting('caelo.actor_kind', true) = 'system');
CREATE POLICY plugin_tool_binding_insert ON plugin_tool_approval_bindings FOR INSERT
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');
-- No UPDATE/DELETE policies: even a host retry cannot rebind an existing call.
