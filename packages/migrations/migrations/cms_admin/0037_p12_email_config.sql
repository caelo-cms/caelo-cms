-- SPDX-License-Identifier: MPL-2.0
--
-- P12 review pass — email transport config (singleton).
--
-- The plugin host's `ctx.email.send` dispatches to whatever transport
-- this row names. v1 supports `none` (the default no-op stub),
-- `smtp` (host/port/user/pass), `resend` (api key), and `ses` (placeholder
-- — wired in P15 cloud adapters). Owner-only writes.

CREATE TABLE IF NOT EXISTS email_config (
  id           int  PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  transport    text NOT NULL CHECK (transport IN ('none','smtp','resend','ses')),
  from_address text NOT NULL DEFAULT '',
  -- transport-specific JSON: smtp = {host, port, secure, user, pass};
  -- resend = {apiKey}; ses = {region, accessKeyId, secretAccessKey}.
  config_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES actors(id),
  CONSTRAINT email_config_singleton CHECK (id = 1)
);

ALTER TABLE email_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_config_authenticated_scope ON email_config;
CREATE POLICY email_config_authenticated_scope ON email_config
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- Seed the singleton row at `none` so reads always succeed (the no-op
-- stub is the safe default; Owner explicitly switches via /security/email).
INSERT INTO email_config (transport, from_address, config_json)
VALUES ('none', '', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
