-- SPDX-License-Identifier: MPL-2.0
-- caelo:contract drops the Google OAuth step-up (step_up_google_client, step_up_challenges, sessions.step_up_email) and narrows sessions.step_up_purpose; an image older than #757 (0279) reads those objects to confirm an update install
-- caelo:requires-earlier-run 0279_step_up_password.sql
--
-- 0333 — the contract half of #757 (issue #759).
--
-- #757 replaced the fresh-Google-sign-in step-up (0268) with a password
-- confirmation as an expand-only change (0279): the release carrying it
-- still found the Google tables, so a rollback to the image before it kept
-- working. Every image since v0.10.50 neither reads nor writes them, so they
-- are dead schema now:
--
--   step_up_google_client          the Owner's hand-made OAuth client
--   step_up_challenges             the OAuth state / PKCE rows
--   sessions.step_up_email         the Google account that did the step-up
--   step_up_purpose 'step_up_client'
--                                  the step-up for saving that client
--
-- The requires-earlier-run header makes the runner refuse an install that
-- jumps from before 0279 straight here: its running image still serves the
-- Google step-up while the migration would drop the tables under it.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- A session whose last step-up was for saving the Google client holds a
-- purpose the narrowed CHECK rejects. Nothing can spend that step-up any
-- more, so clear it instead of letting the constraint fail.
UPDATE sessions
   SET step_up_at = NULL,
       step_up_purpose = NULL
 WHERE step_up_purpose = 'step_up_client';

-- 0268 added the CHECK inline on ADD COLUMN, so Postgres named it
-- sessions_step_up_purpose_check. Dropping it by that name fails loudly if
-- the schema drifted instead of leaving the wide constraint in place.
ALTER TABLE sessions DROP CONSTRAINT sessions_step_up_purpose_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_step_up_purpose_check
    CHECK (step_up_purpose IN ('platform_update', 'update_policy'));

ALTER TABLE sessions DROP COLUMN step_up_email;

DROP TABLE step_up_challenges;
DROP TABLE step_up_google_client;

COMMIT;
