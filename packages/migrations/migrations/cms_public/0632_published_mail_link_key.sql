-- SPDX-License-Identifier: MPL-2.0
--
-- 0632 — #1432: the published copy of the key that signs unsubscribe links.
--
-- The admin creates and holds the key in cms_admin (`site_settings`, cms_admin
-- 0635) and publishes each environment's own into this column; the gateway
-- checks a link's signature with it. Like every published column it flows one
-- way: public_role may only read it, and the admin never reads it back.
-- NULL = the admin that published the row predates this column; the gateway
-- then refuses unsubscribe calls naming the fix (CLAUDE.md §2 no fallbacks).
--
-- Not a contract migration: new and nullable, and the migration run
-- republishes the settings.

ALTER TABLE published_gateway_settings ADD COLUMN IF NOT EXISTS mail_link_key text NULL;
