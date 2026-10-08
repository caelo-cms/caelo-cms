-- SPDX-License-Identifier: MPL-2.0
--
-- 0244 — two more actions behind the owner-settings §11.A gate (agent-tool
-- parity): a plugin's AI cost cap (plugins.set_ai_cost_cap) and rotating the
-- public gateway's cookie secret (gateway.rotate_cookie_secret). Both stay
-- human+system at the op; the AI proposes through
-- owner_settings.propose_set_plugin_ai_cost_cap /
-- owner_settings.propose_rotate_gateway_cookie_secret and the operator's
-- Approve runs owner_settings.execute_proposal. The kind CHECK widens — the
-- table, its RLS and the cross-domain plumbing (inbox, bell, GC, cancel)
-- already cover every kind — and at most ONE rotation may wait at a time:
-- approving two would rotate twice and also invalidate the cookies issued
-- between the approvals. The payload-hash dedup index cannot hold that (the
-- reason differs per proposal), and a check-then-insert in the op races, so
-- a partial unique index enforces it.

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

CREATE UNIQUE INDEX IF NOT EXISTS owner_settings_pending_actions_one_cookie_rotation_uniq
  ON owner_settings_pending_actions (kind)
  WHERE status = 'pending' AND kind = 'rotate_gateway_cookie_secret';

COMMIT;
