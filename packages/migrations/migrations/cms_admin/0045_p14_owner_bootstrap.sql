-- SPDX-License-Identifier: MPL-2.0
--
-- P14 — owner bootstrap tokens. cms-provision generates a one-shot
-- token that the first user redeems at /setup?token=<…> to create the
-- initial Owner account. Tokens are single-use + TTL-bound so a leaked
-- token doesn't permanently expose the install.

CREATE TABLE IF NOT EXISTS owner_bootstrap_tokens (
  token       text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz NULL,
  used_by     uuid NULL REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS owner_bootstrap_tokens_expires_idx
  ON owner_bootstrap_tokens (expires_at);

ALTER TABLE owner_bootstrap_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_bootstrap_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_bootstrap_tokens_system ON owner_bootstrap_tokens;
CREATE POLICY owner_bootstrap_tokens_system ON owner_bootstrap_tokens
  USING (current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');
