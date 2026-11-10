-- SPDX-License-Identifier: MPL-2.0
--
-- 0683 — issue #1550: the staging view of the redirects. Runs in both
-- public databases (migrate.ts `public` and `public-staging`; the staging
-- run grants to the staging gateway's own login instead of public_role,
-- runner.ts retargetVisitorRole), so both have one schema; only
-- cms_public_staging gets rows.
--
-- Redirects are draft state now (cms_admin 0683): `published_redirects`
-- keeps the live rows, and this table carries the Staged changes of the
-- shared draft, one per address — a create or change (`to_path` set) or a
-- removal (`to_path` NULL). The staging gateway serves the live rows with
-- these applied, against the staged build: a change whose same-site target
-- the build does not serve waits, and so does an automatic removal whose
-- page the build does not serve at the address yet (`planRedirectRelease`,
-- @caelo-cms/shared). Both tables are the one projection section
-- `redirects`.
--
-- A gateway of the previous release reads `published_redirects` only and
-- keeps serving the live rows on staging during the roll.

CREATE TABLE IF NOT EXISTS published_redirect_changes (
  id          uuid PRIMARY KEY,
  address     text NOT NULL UNIQUE CHECK (address LIKE '/%' AND length(address) <= 2048),
  from_path   text NOT NULL CHECK (from_path LIKE '/%' AND length(from_path) <= 2048),
  to_path     text NULL CHECK (to_path IS NULL OR length(to_path) <= 2048),
  status_code int  NULL CHECK (status_code IS NULL OR status_code IN (301, 302, 307, 308, 410)),
  automatic   boolean NOT NULL,
  CHECK ((to_path IS NULL) = (status_code IS NULL))
);

ALTER TABLE published_redirect_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_redirect_changes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS published_redirect_changes_publisher ON published_redirect_changes;
CREATE POLICY published_redirect_changes_publisher ON published_redirect_changes TO admin_role
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));
DROP POLICY IF EXISTS published_redirect_changes_gateway_read ON published_redirect_changes;
CREATE POLICY published_redirect_changes_gateway_read ON published_redirect_changes
  FOR SELECT TO public_role USING (true);
GRANT SELECT ON published_redirect_changes TO public_role;
