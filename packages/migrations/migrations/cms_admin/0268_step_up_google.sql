-- SPDX-License-Identifier: MPL-2.0
--
-- 0268 — step-up with a fresh Google sign-in (epic #696, maintainer
-- decision 4).
--
-- Installing a Caelo release and changing the update policy need more than
-- the Owner's session cookie: the Owner signs in to Google again, right
-- then, and Google confirms it (OpenID Connect `max_age=0`; the ID token's
-- `auth_time` must be later than the moment the step-up began). There is no
-- password variant. A stolen session cookie or an unattended browser can
-- therefore not install an update.
--
--   sessions.step_up_at / step_up_email / step_up_purpose
--                                         the last verified step-up of THIS
--                                         session (Google's auth_time), the
--                                         Google account that did it and
--                                         the action it was for. Each
--                                         guarded action consumes it.
--   step_up_challenges                    one row per started sign-in: the
--                                         OAuth state (hashed), PKCE
--                                         verifier and nonce; redeemed once
--                                         by the callback, then recorded
--                                         once (the ID token's nonce must
--                                         match); 10 minutes.
--   step_up_google_client                 singleton: the Google OAuth
--                                         client the Owner created for this
--                                         install; secret encrypted with
--                                         the install KEK (secret-box.ts).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS step_up_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS step_up_email text NULL,
  -- What the sign-in was for: a step-up begun to change the policy cannot
  -- be spent on installing an update, or the other way round.
  ADD COLUMN IF NOT EXISTS step_up_purpose text NULL
    CHECK (step_up_purpose IN ('platform_update', 'update_policy', 'step_up_client'));

CREATE TABLE step_up_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- sha256 hex of the session token the step-up is for; only that session
  -- may complete it and receives the step-up.
  session_hash    text NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  -- sha256 hex of the OAuth `state` (the raw value only travels via Google).
  state_hash      text NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  nonce           text NOT NULL CHECK (char_length(nonce) BETWEEN 32 AND 128),
  code_verifier   text NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  purpose         text NOT NULL CHECK (purpose IN ('platform_update', 'update_policy', 'step_up_client')),
  -- Admin path to return to (validated relative path).
  return_to       text NOT NULL CHECK (return_to ~ '^/[A-Za-z0-9/_-]*$' AND char_length(return_to) <= 200),
  redirect_uri    text NOT NULL CHECK (char_length(redirect_uri) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  -- Set when the callback took the challenge back for the code exchange;
  -- the step-up can then be recorded once against exactly this row.
  redeemed_at     timestamptz NULL
);
CREATE INDEX step_up_challenges_expiry ON step_up_challenges (expires_at);

CREATE TABLE step_up_google_client (
  id                      smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  client_id               text NOT NULL
                          CHECK (client_id ~ '^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$'),
  client_secret_encrypted bytea NOT NULL,
  client_secret_iv        bytea NOT NULL,
  client_secret_kek_fp    text NOT NULL,
  updated_by              uuid NULL REFERENCES actors(id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- A user's own challenges only (system: GC + tests).
ALTER TABLE step_up_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_up_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY step_up_challenges_actor_scope ON step_up_challenges
  USING (user_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
         OR current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (user_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
              OR current_setting('caelo.actor_kind', true) = 'system');

ALTER TABLE step_up_google_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_up_google_client FORCE ROW LEVEL SECURITY;
CREATE POLICY step_up_google_client_authenticated_scope ON step_up_google_client
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
