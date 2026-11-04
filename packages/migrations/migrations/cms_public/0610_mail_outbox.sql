-- SPDX-License-Identifier: MPL-2.0
--
-- 0610 — #1337 (epic #763 M7, E12): the mail outbox of a public database.
--
-- The public gateways have no mail transport and must never hold one. A
-- public operation that mails a visitor (a double opt-in, a password reset)
-- queues a row here instead (plugin-host `ctx.email.queue`); the admin
-- drains the outbox on its scheduler tick and sends the mail with the
-- transport configured in cms_admin (admin-core `email/outbox.ts`). Every
-- public database has its own outbox: this migration runs on cms_public and,
-- retargeted to the staging visitor role, on cms_public_staging (#1329).
--
-- The table is an inbox (#1332, E10): the visitor role may INSERT its
-- payload columns and nothing else. It cannot read the queue back (no
-- addresses leave it again), delete or change a row. Everything in it is
-- attacker-writable data (docs/dev/public-admin-boundary.md), so a row
-- carries only WHAT to send to WHOM, never the mail itself:
--
--   plugin_id  the plugin that queued it; must be an active plugin the
--              admin published (policy below, like 0300)
--   template   a name; the subject, text and link come from that plugin's
--              signed manifest as the admin loaded it
--   recipient  one address, shape-checked here and again by the admin
--   token      at most one opaque token for the template's link, of a
--              fixed charset, so it cannot carry text, markup or a host
--
-- `id` comes from the sequence and `created_at` from now(), never from the
-- writer: the admin expires rows by `created_at` and drains by `id`.
-- How many mails a recipient or the whole site gets is capped by the admin
-- at delivery (cms_admin `public_mail_deliveries`), not here: a writer can
-- queue any number of rows, but not get more than the caps delivered.

CREATE TABLE IF NOT EXISTS mail_outbox (
  id          bigserial PRIMARY KEY,
  plugin_id   uuid NOT NULL,
  template    text NOT NULL CHECK (template ~ '^[a-z][a-z0-9_]{0,63}$'),
  recipient   text NOT NULL CHECK (
    char_length(recipient) <= 254
    AND recipient ~ '^[^][[:space:]@<>",;:\\()]+@[^][[:space:]@<>",;:\\()]+\.[^][[:space:]@<>",;:\\()]+$'
  ),
  token       text NULL CHECK (token IS NULL OR token ~ '^[A-Za-z0-9_-]{16,128}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The drain deletes expired rows by age before it claims by id.
CREATE INDEX IF NOT EXISTS mail_outbox_created_idx ON mail_outbox (created_at);

ALTER TABLE mail_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_outbox FORCE ROW LEVEL SECURITY;

-- The visitor role queues only for a plugin the admin published as active
-- (`published_plugins` IS the active registry, see 0300). It reads that
-- table under its own SELECT grant and RLS, so no SECURITY DEFINER.
DROP POLICY IF EXISTS mail_outbox_gateway ON mail_outbox;
CREATE POLICY mail_outbox_gateway ON mail_outbox
  FOR INSERT TO public_role
  WITH CHECK (EXISTS (SELECT 1 FROM published_plugins p WHERE p.id = mail_outbox.plugin_id));

-- The admin drains (reads and deletes) and may queue itself (a plugin
-- operation run in the admin, e.g. the Owner panel), as any identified actor.
DROP POLICY IF EXISTS mail_outbox_admin ON mail_outbox;
CREATE POLICY mail_outbox_admin ON mail_outbox
  TO admin_role
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

GRANT INSERT (plugin_id, template, recipient, token) ON mail_outbox TO public_role;
GRANT USAGE ON SEQUENCE mail_outbox_id_seq TO public_role;
GRANT SELECT, INSERT, DELETE ON mail_outbox TO admin_role;
GRANT USAGE ON SEQUENCE mail_outbox_id_seq TO admin_role;
