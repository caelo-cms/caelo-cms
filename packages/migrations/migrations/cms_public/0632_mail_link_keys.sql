-- SPDX-License-Identifier: MPL-2.0
--
-- 0632 — #1432: the key that signs unsubscribe links.
--
-- A mail client's one-click unsubscribe (RFC 8058) cannot solve a
-- proof-of-work, so the host signs each recipient's token and the gateway
-- accepts the POST on that signature (plugin-host mail-link-token.ts). The
-- admin signs, the gateway checks, and neither holds a secret in its
-- environment, so the key is one row of each public database: this
-- migration runs on cms_public and, retargeted to the staging visitor role,
-- on cms_public_staging, each with its own key.
--
-- The key never rotates: the links in sent mail do not expire. That is why
-- it is not the gateway's cookie secret, which rotates. Both roles may only
-- read it: a compromised gateway can forge an unsubscribe of a row in its
-- own database, which it can write anyway, but it cannot replace the key.
-- gen_random_uuid() draws from the server's strong random source; two of
-- them make the 32 bytes, 244 of those bits random.
--
-- Expand-only: nothing reads the table before this release.

CREATE TABLE IF NOT EXISTS mail_link_keys (
  id         smallint    PRIMARY KEY CHECK (id = 1),
  key        bytea       NOT NULL CHECK (octet_length(key) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO mail_link_keys (id, key)
VALUES (1, decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'))
ON CONFLICT (id) DO NOTHING;

ALTER TABLE mail_link_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_link_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mail_link_keys_gateway ON mail_link_keys;
CREATE POLICY mail_link_keys_gateway ON mail_link_keys
  FOR SELECT TO public_role USING (true);

DROP POLICY IF EXISTS mail_link_keys_admin ON mail_link_keys;
CREATE POLICY mail_link_keys_admin ON mail_link_keys
  FOR SELECT TO admin_role
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

GRANT SELECT ON mail_link_keys TO public_role;
GRANT SELECT ON mail_link_keys TO admin_role;
