-- SPDX-License-Identifier: MPL-2.0
--
-- 0248 — `gateway_role`: the API gateway's own cms_admin login (issue #613,
-- CLAUDE.md §2 "never let the API Gateway hold admin_role credentials").
--
-- Before this the public gateway connected to cms_admin as admin_role, so a
-- compromised gateway had the whole authoring database. It now logs in as
-- gateway_role, which can reach exactly what serving /api/* needs and
-- nothing else:
--
--   read   site_settings      the four gateway columns (cookie secret, body
--                             cap, captcha provider + difficulty)
--   read   plugin_rate_limit_overrides, rate_limit_profiles
--   write  rate_limit_buckets only the gateway's own keys (`gateway:` and
--                             `gateway-ip:`), enforced by a RESTRICTIVE policy
--                             — the admin's login throttles stay out of reach
--   write  pow_challenges     issue + atomically claim captcha challenges
--   write  gateway_request_log append only
--   write  audit_events       append only, and only rows attributed to a
--                             plugin actor (RESTRICTIVE policy) — the plugin
--                             op audit the redeploy orchestrator watches
--   read   plugins, actors    the registry the admin maintains, so the
--                             gateway can attach the plugins an Owner
--                             activated (it never registers, provisions or
--                             activates anything itself)
--   read   plugin_capability_grants, plugin_installation_versions
--                             the approval state of runtime-installed plugins
--
-- Column-level grants keep the rest of each row out of reach (no plugin
-- signatures, no AI cost caps, no other site settings). Plugin-owned
-- cms_admin schemas grant the role SELECT themselves, and only for
-- release-signed plugins that serve visitors (plugin-sandbox
-- adminSchemaFromSpec).
--
-- Creating a role needs CREATEROLE. Cloud SQL's admin_role has it, so on GCP
-- the role is created here — deliberately in SQL and NOT through the Cloud
-- SQL Admin API: an API-created user becomes a member of cloudsqlsuperuser,
-- which would hand the gateway far more than these grants. It is created
-- without a password; `cms-provision` sets it from the `gateway-role-password`
-- secret after migrations. Locally, in CI and on self-hosted installs
-- bootstrap.sh creates it (as the superuser) and calls
-- caelo_grant_gateway_role() so a database that predates the role converges
-- too. Where the role cannot be created, this migration grants nothing
-- rather than failing the upgrade — the gateway then refuses to boot with a
-- message naming the missing role.
--
-- The grants live in a function so that bootstrap.sh can re-apply them after
-- creating the role on a database this migration already ran against.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role')
     AND (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    -- No password: password authentication fails until provisioning sets one.
    CREATE ROLE gateway_role LOGIN NOINHERIT;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION caelo_grant_gateway_role() RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN
    RETURN;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO gateway_role', current_database());
  GRANT USAGE ON SCHEMA public TO gateway_role;

  -- Settings the gateway runs with. The cookie secret is seeded below and
  -- rotated by the admin (gateway.rotate_cookie_secret); the gateway never
  -- writes site_settings.
  GRANT SELECT (id, gateway_cookie_secret, gateway_max_body_bytes, captcha_provider,
                captcha_pow_target_prefix)
    ON site_settings TO gateway_role;

  -- Rate limiting.
  GRANT SELECT ON plugin_rate_limit_overrides, rate_limit_profiles TO gateway_role;
  GRANT SELECT, INSERT, UPDATE ON rate_limit_buckets TO gateway_role;
  DROP POLICY IF EXISTS rate_limit_buckets_gateway_keys ON rate_limit_buckets;
  CREATE POLICY rate_limit_buckets_gateway_keys ON rate_limit_buckets
    AS RESTRICTIVE FOR ALL TO gateway_role
    USING (starts_with(key, 'gateway:') OR starts_with(key, 'gateway-ip:'))
    WITH CHECK (starts_with(key, 'gateway:') OR starts_with(key, 'gateway-ip:'));

  -- Proof-of-work captcha: issue, then claim once.
  GRANT SELECT (challenge, target_hex, expires_at, used_at) ON pow_challenges TO gateway_role;
  GRANT INSERT (challenge, target_hex, expires_at, visitor_id_hash)
    ON pow_challenges TO gateway_role;
  GRANT UPDATE (used_at) ON pow_challenges TO gateway_role;

  -- Request log: append only.
  GRANT INSERT (plugin_slug, operation, visitor_id_hash, status_code, duration_ms, body_bytes,
                was_rate_limited, was_honeypot_caught, captcha_passed, error_kind)
    ON gateway_request_log TO gateway_role;

  -- Plugin op audit: append only, plugin actors only.
  GRANT INSERT (actor_id, operation, input_hash, succeeded, entity_id)
    ON audit_events TO gateway_role;
  DROP POLICY IF EXISTS audit_events_gateway_plugin_only ON audit_events;
  CREATE POLICY audit_events_gateway_plugin_only ON audit_events
    AS RESTRICTIVE FOR ALL TO gateway_role
    USING (false)
    WITH CHECK (EXISTS (
      SELECT 1 FROM actors a WHERE a.id = audit_events.actor_id AND a.plugin_id IS NOT NULL
    ));

  -- The plugin registry, read-only.
  GRANT SELECT (id, slug, version, tier, status, manifest_json, source_code)
    ON plugins TO gateway_role;
  GRANT SELECT (id, plugin_id) ON actors TO gateway_role;
  GRANT SELECT (id, plugin_id, artifact_digest, capability, revoked_at)
    ON plugin_capability_grants TO gateway_role;
  GRANT SELECT (plugin_id, artifact_digest, status)
    ON plugin_installation_versions TO gateway_role;
END
$fn$;

-- Only the migration runner and bootstrap.sh (the superuser) call it.
REVOKE ALL ON FUNCTION caelo_grant_gateway_role() FROM PUBLIC;

SELECT caelo_grant_gateway_role();

-- The gateway used to generate its cookie secret on first request, which
-- needed write access to site_settings. Seed it here instead (64 random
-- bytes as 128 hex characters, the shape gateway.rotate_cookie_secret
-- writes); rotation stays an admin operation.
UPDATE site_settings
   SET gateway_cookie_secret = encode(
         sha512(convert_to(gen_random_uuid()::text || gen_random_uuid()::text
                           || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')),
         'hex')
 WHERE id = 1 AND (gateway_cookie_secret IS NULL OR gateway_cookie_secret = '');
