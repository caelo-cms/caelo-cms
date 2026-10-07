-- SPDX-License-Identifier: MPL-2.0
--
-- 0235 — revoking a plugin capability joins the plugin pending queue.
--
-- `plugins.revoke_capability` was reachable only from the Owner's
-- /security/plugins/installations page, so an agent asked to "take the
-- image-generation access away from that plugin" had to send the operator
-- off to do it by hand. Revoking is a §11.A action, not a routine one: when
-- the grant belongs to the running version the plugin is disabled, and
-- getting it back means a fresh Owner approval of the installation — not
-- one tool call. So the AI proposes (`plugins.propose_revoke_capability`),
-- the operator approves in the chat, and `plugins.execute_proposal`
-- applies the existing op.
--
-- The status CHECK also gains 'cancelled' (the v0.2.35 unified shape every
-- other pending table has), so `pending_proposals.cancel` can withdraw an
-- AI's own plugin proposal like any other.
--
-- (Migration number: if the owner-settings PR lands first it holds 0234;
-- this file only widens a CHECK and is order-independent of it.)

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE plugin_pending_actions DROP CONSTRAINT IF EXISTS plugin_pending_actions_kind_check;
ALTER TABLE plugin_pending_actions
  ADD CONSTRAINT plugin_pending_actions_kind_check
  CHECK (kind IN ('uninstall', 'activate', 'revoke_capability'));

ALTER TABLE plugin_pending_actions DROP CONSTRAINT IF EXISTS plugin_pending_actions_status_check;
ALTER TABLE plugin_pending_actions
  ADD CONSTRAINT plugin_pending_actions_status_check
  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled'));

COMMIT;
