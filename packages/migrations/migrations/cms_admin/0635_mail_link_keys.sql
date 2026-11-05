-- SPDX-License-Identifier: MPL-2.0
--
-- 0635 — #1432: the keys that sign unsubscribe links.
--
-- A mail client's one-click unsubscribe (RFC 8058) cannot solve a
-- proof-of-work, so the admin signs each recipient's token and the gateway
-- checks the signature (plugin-host mail-link-token.ts). The key is created
-- and held here and published one way into `published_gateway_settings`
-- (cms_public 0632), so the admin never reads it back from the public side.
--
-- One key per environment, like the cookie secrets: cms_public and
-- cms_public_staging each get only their own. Unlike a cookie secret the key
-- never rotates, because the links in sent mail do not expire.
--
-- This UPDATE covers fresh and existing installs alike: the `site_settings`
-- row exists on both by now, and the migration run publishes the settings
-- when it ends. 64 random hex characters, as 0531 makes its secret.

ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS mail_link_key text NULL;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS mail_link_staging_key text NULL;

UPDATE site_settings
   SET mail_link_key = COALESCE(
         mail_link_key,
         replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
       ),
       mail_link_staging_key = COALESCE(
         mail_link_staging_key,
         replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
       )
 WHERE mail_link_key IS NULL OR mail_link_staging_key IS NULL;

DROP TRIGGER IF EXISTS caelo_projection_settings ON site_settings;
CREATE TRIGGER caelo_projection_settings
  AFTER INSERT OR UPDATE OF gateway_cookie_secret, gateway_staging_cookie_secret,
                            gateway_max_body_bytes, captcha_provider, captcha_pow_target_prefix,
                            mail_link_key, mail_link_staging_key
  ON site_settings FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('settings');
