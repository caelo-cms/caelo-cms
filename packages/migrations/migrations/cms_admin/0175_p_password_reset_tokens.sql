-- SPDX-License-Identifier: MPL-2.0
--
-- 0175 — self-service password reset tokens.
--
-- Backs `auth.request_password_reset` / `auth.reset_password`. Each row is a
-- short-lived, single-use reset grant. We store ONLY the SHA-256 hash of the
-- token — the raw token exists solely in the emailed reset link, so a DB read
-- (or a leaked backup) can never mint a working link. `used_at` makes a token
-- one-shot; `expires_at` bounds its lifetime.
--
-- RLS mirrors `sessions` (self-or-system). Every reset op runs in a SYSTEM
-- context because the requester is, by definition, not authenticated — the
-- system bypass is what lets the unauthenticated flow read/write these rows,
-- while a normal human actor can only ever see their own.

BEGIN;

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Lookup by hash on redemption; by user when we invalidate a user's outstanding
-- tokens (a new request or a completed reset supersedes older ones).
CREATE INDEX password_reset_tokens_token_hash_idx ON password_reset_tokens (token_hash);
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS password_reset_tokens_self_or_system ON password_reset_tokens;
CREATE POLICY password_reset_tokens_self_or_system ON password_reset_tokens
  USING (user_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
         OR current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (user_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid
              OR current_setting('caelo.actor_kind', true) = 'system');

COMMIT;
