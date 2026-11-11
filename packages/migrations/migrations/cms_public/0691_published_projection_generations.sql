-- SPDX-License-Identifier: MPL-2.0
--
-- 0691 — issue #1594: the newest read each public database was written
-- from, per write unit. Runs in both public databases (migrate.ts `public`
-- and `public-staging`), so both have one schema.
--
-- A publisher reads cms_admin under the projection lock and takes the read
-- transaction's id as its generation; the lock ends with the read, and the
-- public writes follow without an admin transaction open. Before writing a
-- unit (settings, staging, staging_site, rate_limits, redirects, plugins,
-- comments) it raises this row to its generation, and leaves the unit alone
-- when a newer generation is already there: an older read never overwrites
-- a newer publish. The row is never deleted, so a section that a newer
-- publish removed (a cleared cookie secret) cannot come back from an older
-- read. The row lock taken by the raise serialises two publishers of the
-- same unit until the first commits.
--
-- Only the admin's publisher (admin_role as the system actor) reads or
-- writes it; the gateways never need it, so the visitor logins get nothing.

CREATE TABLE IF NOT EXISTS published_projection_generations (
  unit       text PRIMARY KEY CHECK (unit IN (
               'settings', 'staging', 'staging_site', 'rate_limits', 'redirects', 'plugins', 'comments')),
  generation bigint NOT NULL CHECK (generation > 0)
);

ALTER TABLE published_projection_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_projection_generations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS published_projection_generations_publisher ON published_projection_generations;
CREATE POLICY published_projection_generations_publisher ON published_projection_generations TO admin_role
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));
