-- SPDX-License-Identifier: MPL-2.0
-- caelo:contract revokes gateway_role's cms_admin login and grants and drops the gateway's legacy cms_admin tables; a gateway older than #635 (0280/0281) can no longer serve /api/*
--
-- 0282 — the contract half of issue #635: the public side has no path to
-- cms_admin (CLAUDE.md §2).
--
-- Since 0280/0281 the API gateway serves /api/* from cms_public alone and
-- no adapter gives it a cms_admin URL. What remained for the previous
-- release's gateway during an upgrade roll goes now:
--
--   - every privilege gateway_role held in cms_admin — CONNECT, the column
--     grants of 0248/0251/0252/0259, the plugin-schema grants of
--     plugin-sandbox adminSchemaFromSpec — and the RESTRICTIVE policies
--     that scoped it;
--   - the role itself, where the migration role may drop it (Cloud SQL:
--     admin_role created it in 0248). Elsewhere (a superuser created it in
--     bootstrap.sh) bootstrap.sh / the self-hosted role setup drops it;
--     until then it is a login with no privilege anywhere, which the role
--     audit (role-audit.ts) verifies after every migration;
--   - the grant functions bootstrap.sh used to re-apply;
--   - the gateway's former cms_admin state: gateway_request_log,
--     pow_challenges and its rate-limit buckets. Its live state is in
--     cms_public since 0280.
--
-- Contract: the release before #635 cannot run its gateway on this schema,
-- so this ships one release after 0280/0281 (see RELEASING.md, contract
-- migrations).

SET LOCAL caelo.actor_kind = 'system';

DROP POLICY IF EXISTS rate_limit_buckets_gateway_keys ON rate_limit_buckets;
DROP POLICY IF EXISTS audit_events_gateway_plugin_only ON audit_events;
DROP POLICY IF EXISTS comment_archive_gateway_approved_only ON comment_archive;

DO $$
DECLARE
  s text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN
    RETURN;
  END IF;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM gateway_role', current_database());
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gateway_role;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM gateway_role;
  REVOKE ALL ON SCHEMA public FROM gateway_role;
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'plugin\_%' LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM gateway_role', s);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM gateway_role', s);
  END LOOP;
  -- Column grants are not covered by REVOKE ALL ON ALL TABLES.
  FOR s IN
    SELECT DISTINCT format('REVOKE ALL (%I) ON %s FROM gateway_role', a.attname, c.oid::regclass)
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      CROSS JOIN LATERAL aclexplode(a.attacl) x
     WHERE x.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'gateway_role')
  LOOP
    EXECUTE s;
  END LOOP;
END
$$;

-- Its own block: a refused DROP ROLE must not undo the revokes above.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway_role') THEN
    DROP ROLE gateway_role;
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR dependent_objects_still_exist THEN
    -- Not the migration role's to drop (a superuser created it in
    -- bootstrap.sh): bootstrap.sh / the self-hosted role setup drops it.
    -- It holds no privilege in cms_admin any more; the role audit checks
    -- exactly that after every migration run.
    RAISE NOTICE 'gateway_role kept, without privileges: %', SQLERRM;
END
$$;

DROP FUNCTION IF EXISTS caelo_grant_gateway_role();
DROP FUNCTION IF EXISTS caelo_grant_gateway_staging_access();

DROP TABLE IF EXISTS gateway_request_log;
DROP TABLE IF EXISTS pow_challenges;
DELETE FROM rate_limit_buckets WHERE starts_with(key, 'gateway:') OR starts_with(key, 'gateway-ip:');
