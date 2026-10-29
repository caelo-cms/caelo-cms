-- SPDX-License-Identifier: MPL-2.0
--
-- 0403 — a plugin's onActivate is serialized by a lease row, not by a
-- transaction held open around it (#1220, epic #1209).
--
-- #1144 serialized one plugin's `onActivate` seed across processes with a
-- transaction-scoped advisory lock: a transaction held the lock while the
-- plugin's seed ran, and the seed's storage writes opened transactions of
-- their own — a second connection of the same pool taken from inside the
-- first, the deadlock class the pool guard refuses (#1210). The plugin's
-- writes must not ride on the host's transaction either: they run under
-- the plugin's identity and row-level security (CLAUDE.md §2).
--
-- So the lock becomes a committed lease, taken and released in short
-- transactions of their own:
--
--   plugin_activation_leases(slug) — the activation of plugin `slug` that
--     runs right now. `holder` names it (one id per activation), renewed on
--     a heartbeat while the seed runs and deleted when it ends. A row whose
--     `expires_at` passed has no live process behind it (crash, instance
--     replaced) and is taken over by the next activation.
--
-- Why a lease may expire: it guards a running process, not an editor's
-- change (CLAUDE.md §2's "locks never expire" is about the cross-branch
-- entity locks) — the same rule as deploy_leases (0393) and
-- chat_turn_leases (0247). Expiry is judged on the database clock.
--
-- Expand-only (#696): a new table. During a rolling update the previous
-- release still serializes by the advisory lock; this release checks that
-- lock (try-lock, never a wait) before it takes the lease
-- (plugin-host activation-lock.ts).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS plugin_activation_leases (
  slug         text PRIMARY KEY,
  holder       text NOT NULL,
  acquired_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at   timestamptz NOT NULL
);

ALTER TABLE plugin_activation_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_activation_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plugin_activation_leases_authenticated_scope ON plugin_activation_leases;
CREATE POLICY plugin_activation_leases_authenticated_scope ON plugin_activation_leases
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
