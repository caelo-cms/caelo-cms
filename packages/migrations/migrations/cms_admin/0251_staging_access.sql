-- SPDX-License-Identifier: MPL-2.0
--
-- 0251 — issue #650: a protected staging domain (staging.<domain>) that
-- serves exactly what goes live.
--
-- `staging_access` (singleton) holds the staging host (an install setting,
-- default staging.<domain>) and the access gate's settings: which
-- modes let a request in (the admin's "Open staging" cookie, generated
-- basic-auth credentials, a secret request header, an IP allowlist) and,
-- on gcp-firebase, the preview-channel origin the gateway proxies
-- staging.<domain> to. It holds NO credential: the basic-auth password and
-- the header value are derived from the `staging-gate-secret` in Secret
-- Manager and the random nonce stored here (@caelo-cms/shared
-- staging-gate.ts), so rotating one is writing a new nonce, and a read of
-- this table alone reveals nothing usable.
--
-- The gateway reads the row as gateway_role (column grants below);
-- only the admin writes it — settings through staging_access.set /
-- rotate_credentials (Owner, or the AI through the owner-settings §11.A
-- gate), the origin through deploy.trigger / deploy.promote.
--
-- deploy_runs gains what Publish live's parity guard needs: the origin a
-- build rendered its absolute URLs with, and the staging build's manifest
-- of host-normalised content hashes (the build directory itself is
-- ephemeral on Cloud Run).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE staging_access (
  id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- The staging site's host (e.g. staging.example.com, or any host the
  -- operator chose). Every staging build renders it and the gate matches
  -- requests on it. NULL until the admin seeds it from CAELO_STAGING_HOST
  -- (provisioning: the wizard's answer, default staging.<domain>); changed
  -- by staging_access.set_host (Owner, or the AI through the §11.A gate).
  staging_host        text CHECK (staging_host ~ '^[a-z0-9.-]{4,253}$'),
  -- "Open staging" from the admin: admin access ⇒ staging access.
  cookie_enabled      boolean NOT NULL DEFAULT true,
  basic_auth_enabled  boolean NOT NULL DEFAULT false,
  basic_auth_user     text NOT NULL DEFAULT 'caelo'
                      CHECK (basic_auth_user ~ '^[A-Za-z0-9._-]{1,64}$'),
  basic_auth_nonce    text,
  header_enabled      boolean NOT NULL DEFAULT false,
  header_name         text NOT NULL DEFAULT 'X-Caelo-Staging-Key'
                      CHECK (header_name ~ '^[A-Za-z0-9-]{1,64}$'),
  header_nonce        text,
  ip_allowlist        text[] NOT NULL DEFAULT '{}',
  -- gcp-firebase: the current staged build's preview-channel origin, never
  -- shown to anyone; NULL when nothing is staged (after Publish live).
  origin_url          text,
  origin_run_id       uuid,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO staging_access (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE staging_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging_access FORCE ROW LEVEL SECURITY;
CREATE POLICY staging_access_authenticated_scope ON staging_access
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE deploy_runs
  ADD COLUMN IF NOT EXISTS site_url text,
  ADD COLUMN IF NOT EXISTS parity_manifest jsonb;

-- Two more actions behind the owner-settings §11.A gate.
ALTER TABLE owner_settings_pending_actions
  DROP CONSTRAINT IF EXISTS owner_settings_pending_actions_kind_check;
ALTER TABLE owner_settings_pending_actions
  ADD CONSTRAINT owner_settings_pending_actions_kind_check
  CHECK (kind IN (
    'set_ai_budget',
    'set_ai_pricing',
    'set_gateway_settings',
    'set_translation_model',
    'set_plugin_ai_cost_cap',
    'rotate_gateway_cookie_secret',
    'set_staging_access',
    'rotate_staging_credentials',
    'set_staging_host'
  ));

COMMIT;

-- gateway_role reads the gate's settings + origin. A function like
-- 0248's caelo_grant_gateway_role, and called next to it by bootstrap.sh /
-- the self-hosted role setup, so a database whose gateway_role is created
-- after this migration ran converges too.
CREATE OR REPLACE FUNCTION caelo_grant_gateway_staging_access() RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN
    RETURN;
  END IF;
  GRANT SELECT (id, staging_host, cookie_enabled, basic_auth_enabled, basic_auth_user, basic_auth_nonce,
                header_enabled, header_name, header_nonce, ip_allowlist, origin_url)
    ON staging_access TO gateway_role;
END
$fn$;
REVOKE ALL ON FUNCTION caelo_grant_gateway_staging_access() FROM PUBLIC;
SELECT caelo_grant_gateway_staging_access();
