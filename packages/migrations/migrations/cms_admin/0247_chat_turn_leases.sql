-- SPDX-License-Identifier: MPL-2.0
--
-- 0247 — issue #628: one turn at a time per chat, across admin instances.
--
-- A chat's history is an ordered conversation: every assistant tool call
-- must be followed by its result before the next message. Two turns of
-- the same chat running at once interleave their rows (a fix-round message
-- landing between a tool call and its result), the provider rejects that
-- history, and because the rows are persisted the chat stays broken.
-- #624 serialized turns with an in-memory queue, which only holds inside
-- one admin process; with several Cloud Run instances a second turn can
-- land on another instance.
--
-- `chat_turn_leases` is the cross-instance half: the running turn holds a
-- lease row for its chat (one row per chat, PRIMARY KEY on the session),
-- renews it on a heartbeat, and deletes it when the turn ends. A second
-- turn of the same chat waits until the row is gone or expired. A lease
-- rather than a session-level advisory lock because a turn runs for
-- minutes: an advisory lock would pin a pooled connection for the whole
-- turn, while a lease row is written through ordinary short Query API
-- ops. A crashed instance stops renewing, so its lease expires and the
-- next turn takes it over — release never depends on the holder's
-- process being alive. Expiry is judged on the DATABASE clock (`now()`),
-- never an instance's wall clock, so clock skew between instances cannot
-- hand one chat to two turns.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE chat_turn_leases (
  chat_session_id uuid PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
  -- Random per-turn id minted by the runner; only its holder may renew or
  -- release the lease.
  holder_id       text NOT NULL,
  acquired_at     timestamptz NOT NULL DEFAULT now(),
  renewed_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);

ALTER TABLE chat_turn_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_turn_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_turn_leases_authenticated_scope ON chat_turn_leases
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
