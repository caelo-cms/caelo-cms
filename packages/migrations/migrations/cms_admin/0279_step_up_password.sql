-- SPDX-License-Identifier: MPL-2.0
--
-- 0279 — step-up with the Caelo password instead of a fresh Google sign-in
-- (#757, revising #696 decision 4).
--
-- The admin already sits behind IAP / the forward-auth proxy, so the
-- step-up only has to stop a bystander at an unlocked computer and a stolen
-- session cookie. The Owner re-enters their password in the same request as
-- the guarded action; the Google OAuth client the Owner had to create by
-- hand in Cloud Console is gone.
--
--   sessions.step_up_failures   wrong passwords entered for a step-up in
--                               this session since the last right one. At
--                               the limit the session is deleted, so a
--                               stolen cookie cannot be used to guess the
--                               password.
--
-- Expand-only (#696): one new column with a default. The previous image
-- neither reads nor writes it, and still finds step_up_google_client,
-- step_up_challenges and sessions.step_up_email, which it needs if an
-- update rolls back to it. Those go in a later contract migration (#759).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS step_up_failures smallint NOT NULL DEFAULT 0
    CHECK (step_up_failures >= 0);

COMMIT;
