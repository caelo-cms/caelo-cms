-- SPDX-License-Identifier: MPL-2.0
--
-- 0600 — what the staging gateway needs to serve the staged site (issue
-- #1330, gateway hardening P3b-2, epic #763 E8/E11; with #1331 the cutover).
--
-- The staging gateway serves the staged build itself, behind the #650 gate,
-- on every host. It has no cms_admin login, so the admin publishes into the
-- staging database (cms_public_staging) one row with everything it needs:
--
--   - the gate's settings (access modes, crawler-credential nonces, the IP
--     allowlist) and its key, `gate_secret`. The key MOVED here from the
--     gateways' env (#1331 decision 2026-11-04): it is the same secret the
--     admin signs "Open staging" links with, never re-minted, so every crawler
--     credential keeps working. Each gateway holds exactly one credential in
--     its env (its database login); the staging gateway's other secret comes
--     through its own environment's projection.
--   - the served build: the run, where its complete files lie in staging
--     storage (`served_location`, a slot of the staging bucket or a build
--     directory), and the origin it was rendered for (`build_origin`, the
--     live site's), which the gateway rewrites to the staging host while it
--     streams.
--
-- The table exists in both public databases (one schema in both), but the
-- publisher writes it ONLY into cms_public_staging: the live database never
-- holds the gate key (admin-core public-projection `writeSnapshot`, pinned by
-- staging-site-projection.integration.test.ts). The staging run grants
-- SELECT to the staging gateway's own login (runner.ts retargetVisitorRole); nothing may
-- write it but the system publisher.

CREATE TABLE IF NOT EXISTS published_staging_site (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  staging_host       text NULL,
  cookie_enabled     boolean NOT NULL,
  basic_auth_enabled boolean NOT NULL,
  basic_auth_user    text NOT NULL,
  basic_auth_nonce   text NULL,
  header_enabled     boolean NOT NULL,
  header_name        text NOT NULL,
  header_nonce       text NULL,
  ip_allowlist       jsonb NOT NULL,
  -- NULL until a process that holds the key published it (the migration job
  -- does not; the admin's boot publish does).
  gate_secret        text NULL CHECK (gate_secret IS NULL OR length(gate_secret) BETWEEN 1 AND 512),
  served_run_id      uuid NULL,
  served_location    text NULL CHECK (served_location IS NULL OR served_location ~ '^[A-Za-z0-9_./-]{1,200}$'),
  build_origin       text NULL CHECK (build_origin IS NULL OR build_origin ~ '^https?://[^/\s]+$')
);

ALTER TABLE published_staging_site ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_staging_site FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS published_staging_site_publisher ON published_staging_site;
CREATE POLICY published_staging_site_publisher ON published_staging_site TO admin_role
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));
DROP POLICY IF EXISTS published_staging_site_gateway_read ON published_staging_site;
CREATE POLICY published_staging_site_gateway_read ON published_staging_site
  FOR SELECT TO public_role USING (true);
GRANT SELECT ON published_staging_site TO public_role;

ALTER TABLE published_projection_sections
  DROP CONSTRAINT IF EXISTS published_projection_sections_section_check;
ALTER TABLE published_projection_sections
  ADD CONSTRAINT published_projection_sections_section_check
  CHECK (section ~ '^(settings|staging|staging_site|rate_limits|plugins|comments|redirects|plugin:[0-9a-f-]{36})$');
