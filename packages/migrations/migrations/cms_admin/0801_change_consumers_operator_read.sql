-- SPDX-License-Identifier: MPL-2.0
--
-- 0801 — issue #1729: plugin health shows a change consumer's pending
-- rebuild (docs/dev/external-plugin-brokers.md §5.2: "a rebuild that never
-- reports done stays rebuilding and is visible in plugin health"). Health
-- is read by the Owner (Settings → Plugins) and the AI (list_plugins,
-- get_plugin), as human and ai actors, and change_consumers was readable
-- only by the system and by each plugin for its own row.
--
-- Read only, and only for human and ai actors: writes stay with the host's
-- consumer runner (system) and a plugin keeps seeing its own row alone.
-- The rows hold journal cursors, claim holders and a plugin's opaque
-- rebuild cursor; health shows none of them, only "rebuilding since".

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

DROP POLICY IF EXISTS change_consumers_operator_read ON change_consumers;
CREATE POLICY change_consumers_operator_read ON change_consumers FOR SELECT
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'ai'));

COMMIT;
