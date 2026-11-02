-- SPDX-License-Identifier: MPL-2.0
--
-- 0530 — the redirects table, published (issue #1329, gateway hardening
-- P3b-1, epic #763 E10). Runs in both public databases (migrate.ts
-- `public` and `public-staging`; the staging run grants to the staging
-- gateway's own login instead of public_role, runner.ts retargetVisitorRole).
--
-- A redirect is a live write (#1157): saving one syncs it to the hosting
-- provider at once, never through a build. The staging site serves its
-- files from the staging gateway (#1330), which has no cms_admin login, so
-- the admin publishes the redirects table into the staging database as a
-- projection section of its own (`redirects`, admin-core public-projection).
-- The live database gets the same table for one schema in both; the live
-- site keeps getting its redirects from the provider sync.
--
-- `published_projection_sections` learns the new section name.

CREATE TABLE IF NOT EXISTS published_redirects (
  id          uuid PRIMARY KEY,
  from_path   text NOT NULL UNIQUE CHECK (from_path LIKE '/%' AND length(from_path) <= 2048),
  to_path     text NOT NULL CHECK (length(to_path) <= 2048),
  status_code int  NOT NULL CHECK (status_code IN (301, 302, 307, 308, 410))
);

ALTER TABLE published_redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_redirects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS published_redirects_publisher ON published_redirects;
CREATE POLICY published_redirects_publisher ON published_redirects TO admin_role
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));
DROP POLICY IF EXISTS published_redirects_gateway_read ON published_redirects;
CREATE POLICY published_redirects_gateway_read ON published_redirects
  FOR SELECT TO public_role USING (true);
GRANT SELECT ON published_redirects TO public_role;

ALTER TABLE published_projection_sections
  DROP CONSTRAINT IF EXISTS published_projection_sections_section_check;
ALTER TABLE published_projection_sections
  ADD CONSTRAINT published_projection_sections_section_check
  CHECK (section ~ '^(settings|staging|rate_limits|plugins|comments|redirects|plugin:[0-9a-f-]{36})$');
