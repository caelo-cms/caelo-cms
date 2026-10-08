-- SPDX-License-Identifier: MPL-2.0
--
-- 0244 — two more actions behind the owner-settings §11.A gate (agent-tool
-- parity): a plugin's AI cost cap (plugins.set_ai_cost_cap) and rotating the
-- public gateway's cookie secret (gateway.rotate_cookie_secret). Both stay
-- human+system at the op; the AI proposes through
-- owner_settings.propose_set_plugin_ai_cost_cap /
-- owner_settings.propose_rotate_gateway_cookie_secret and the operator's
-- Approve runs owner_settings.execute_proposal. Only the kind CHECK widens —
-- the table, its RLS and the cross-domain plumbing (inbox, bell, GC, cancel)
-- already cover every kind.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE owner_settings_pending_actions
  DROP CONSTRAINT IF EXISTS owner_settings_pending_actions_kind_check;
ALTER TABLE owner_settings_pending_actions
  ADD CONSTRAINT owner_settings_pending_actions_kind_check
  CHECK (kind IN (
    'set_ai_budget',
    'set_ai_pricing',
    'set_gateway_settings',
    'set_translation_model',
    'set_plugin_ai_cost_cap',
    'rotate_gateway_cookie_secret'
  ));

COMMIT;
