-- SPDX-License-Identifier: MPL-2.0
--
-- 0475 — RLS setting tests the planner estimates as "passes" (issue #1297),
-- cms_public half. The reasoning is in cms_admin/0475: a Var-free policy
-- term `current_setting(...) = 'x'` stays a row filter (policy quals are
-- never pseudoconstant) and is estimated at 0.5 % of the rows; spelled
-- through `caelo_setting_is` / `caelo_setting_in` (inlined NullTest) it is
-- estimated at 99.5 %, with the same truth table. Every plugin table in
-- this database (plugin-sandbox schema emitter) uses `caelo_setting_is`
-- from this release on.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE OR REPLACE FUNCTION caelo_setting_is(setting text, expected text)
  RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting(setting, true) = expected, false) IS NOT NULL $$;

COMMENT ON FUNCTION caelo_setting_is(text, text) IS
  'RLS: the session setting equals expected (missing setting = false). Inlined by the planner and estimated as 99.5 % of rows instead of the 0.5 % a Var-free equality gets (#1297).';

CREATE OR REPLACE FUNCTION caelo_setting_in(setting text, expected text[])
  RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting(setting, true) = ANY (expected), false) IS NOT NULL $$;

COMMENT ON FUNCTION caelo_setting_in(text, text[]) IS
  'RLS: the session setting is one of expected (missing setting = false). Inlined by the planner and estimated as 99.5 % of rows instead of n × 0.5 % (#1297).';

ALTER POLICY plugin_schema_provisions_system ON plugin_schema_provisions
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY published_comments_publisher ON published_comments
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY published_gateway_settings_publisher ON published_gateway_settings
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY published_plugin_grants_publisher ON published_plugin_grants
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY published_plugin_rows_publisher ON published_plugin_rows
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY published_plugins_publisher ON published_plugins
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY published_projection_sections_publisher ON published_projection_sections
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY published_rate_limits_publisher ON published_rate_limits
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

ALTER POLICY published_staging_access_publisher ON published_staging_access
  USING ((caelo_setting_is('caelo.actor_kind', 'system')))
  WITH CHECK ((caelo_setting_is('caelo.actor_kind', 'system')));

COMMIT;
