-- SPDX-License-Identifier: MPL-2.0
--
-- Activation joins uninstall in the plugin pending queue.
--
-- Activating a plugin runs code that was not running before: it adds
-- tools the AI can call, skills that steer it, background workers, and
-- URL contributions that reshape live page paths. That is squarely the
-- §11.A "hard to revert with one tool call" class, so it goes the same
-- way every other gated action does — the AI proposes, the operator
-- approves in the chat, and only then does anything load.
--
-- The alternative the AI has today is to tell the operator to leave the
-- conversation and find /security/plugins, which is exactly the
-- round-trip §11.A exists to remove.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE plugin_pending_actions DROP CONSTRAINT IF EXISTS plugin_pending_actions_kind_check;
ALTER TABLE plugin_pending_actions
  ADD CONSTRAINT plugin_pending_actions_kind_check
  CHECK (kind IN ('uninstall', 'activate'));

COMMIT;
