-- SPDX-License-Identifier: MPL-2.0
--
-- RLS policies for cms_admin. Co-evolves with the schema: every new table
-- added to cms_admin must land alongside a CREATE POLICY here, or the drift
-- check in migrate.ts fails loudly.
--
-- Per-actor scope: a row is visible/mutable only to its owning actor, with a
-- bypass for `system`-kind sessions (bootstrap, seed, P2 actor creation).
-- NULL/empty session settings produce no match → fail closed.

ALTER TABLE actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE actors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS actors_actor_scope ON actors;
CREATE POLICY actors_actor_scope ON actors
  USING (id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid OR current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid OR current_setting('caelo.actor_kind', true) = 'system');

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_events_actor_scope ON audit_events;
CREATE POLICY audit_events_actor_scope ON audit_events
  USING (actor_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid OR current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (actor_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid OR current_setting('caelo.actor_kind', true) = 'system');
