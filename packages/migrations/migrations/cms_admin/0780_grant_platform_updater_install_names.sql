-- SPDX-License-Identifier: MPL-2.0
--
-- 0780 — caelo_grant_platform_updater() takes the install's names (#1689).
--
-- Migration 0270's function re-applies the upgrader role's grants (0267,
-- 0270) for the self-hosted role convergence, which creates the role as the
-- superuser after the migrations ran. It names the role and the databases
-- in its body. The migration runner renames those names for an install with
-- its own name map (runner.ts `installNameTokens`), but a database copied
-- from a template (install-from-template.ts) keeps the TEMPLATE's body, so
-- the next call in the copy would grant to the template's role and open the
-- template's databases to it.
--
-- The replacement takes the role and both database names as arguments and
-- names nothing itself. The call below is renamed like every other name in
-- a migration, and the convergence passes the install's names
-- (provisioning self-hosted-roles.ts). It refuses an admin database other
-- than the one it runs in, so a call with another install's names fails
-- instead of granting there. Same grants and policies as 0270, verbatim.
--
-- Expand only: the previous release's self-hosted convergence (v0.12.14,
-- self-hosted-roles.ts) still calls the version without arguments, also
-- after a rollback onto this schema. So 0270's function stays, as a
-- wrapper that passes this install's names (renamed by the runner like the
-- call at the end). A later release drops it (#1722). In a database
-- copied from a template the wrapper names the template, so the template
-- copy drops it (template-rebind.ts `DROP_IN_COPY_SQL`): copies exist only
-- since this release (install-from-template.ts), so no older release's
-- convergence ever runs against one. Called in a copy anyway, it would
-- fail: the 3-argument function refuses the template's admin database.

CREATE OR REPLACE FUNCTION caelo_grant_platform_updater(
  updater name,
  admin_database name,
  public_database name
) RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF admin_database <> current_database() THEN
    RAISE EXCEPTION 'caelo_grant_platform_updater: runs in its admin database % (called for %): pass this install''s names (#1689)',
      current_database(), admin_database;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = updater) THEN
    RETURN;
  END IF;

  -- caelo:dynamic-grantee updater is the install's upgrader role, named by the caller (the call below, the self-hosted convergence)
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', admin_database, updater);
  -- caelo:dynamic-grantee updater is the install's upgrader role, named by the caller
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', public_database, updater);
  -- caelo:dynamic-grantee updater is the install's upgrader role, named by the caller
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', updater);
  -- caelo:dynamic-grantee updater is the install's upgrader role, named by the caller
  EXECUTE format('GRANT SELECT ON platform_update_requests, platform_update_policy TO %I', updater);
  -- caelo:dynamic-grantee updater is the install's upgrader role, named by the caller
  EXECUTE format('GRANT UPDATE (status, status_reason, refusal_codes, execution, started_at, finished_at,
    manifest_security, contract_migrations, infra_contract_required, infra_contract_installed,
    admin_digest, gateway_digest, ops_digest, backup_id) ON platform_update_requests TO %I', updater);
  -- caelo:dynamic-grantee updater is the install's upgrader role, named by the caller
  EXECUTE format('GRANT INSERT ON platform_update_events TO %I', updater);
  -- caelo:dynamic-grantee updater is the install's upgrader role, named by the caller
  EXECUTE format('GRANT UPDATE (paused, paused_reason, paused_at) ON platform_update_policy TO %I', updater);
  -- caelo:dynamic-grantee updater is the install's upgrader role, named by the caller
  EXECUTE format('GRANT INSERT ON audit_events TO %I', updater);
  DROP POLICY IF EXISTS platform_update_requests_updater ON platform_update_requests;
  EXECUTE format('CREATE POLICY platform_update_requests_updater ON platform_update_requests
    FOR ALL TO %I USING (true) WITH CHECK (true)', updater);
  DROP POLICY IF EXISTS platform_update_events_updater ON platform_update_events;
  EXECUTE format('CREATE POLICY platform_update_events_updater ON platform_update_events
    FOR INSERT TO %I WITH CHECK (true)', updater);
  DROP POLICY IF EXISTS platform_update_policy_updater ON platform_update_policy;
  EXECUTE format('CREATE POLICY platform_update_policy_updater ON platform_update_policy
    FOR ALL TO %I USING (true) WITH CHECK (true)', updater);

  -- The heartbeat: the agent upserts its one row and nothing else here.
  -- caelo:dynamic-grantee updater is the install's upgrader role, named by the caller
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON platform_update_agent TO %I', updater);
  DROP POLICY IF EXISTS platform_update_agent_updater ON platform_update_agent;
  EXECUTE format('CREATE POLICY platform_update_agent_updater ON platform_update_agent
    FOR ALL TO %I USING (true) WITH CHECK (true)', updater);
END
$fn$;

-- Only the migration runner and the superuser's role convergence call it.
REVOKE ALL ON FUNCTION caelo_grant_platform_updater(name, name, name) FROM PUBLIC;

-- The previous release's convergence calls this one (see the header).
CREATE OR REPLACE FUNCTION caelo_grant_platform_updater() RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM caelo_grant_platform_updater('platform_updater', 'cms_admin', 'cms_public');
END
$fn$;

REVOKE ALL ON FUNCTION caelo_grant_platform_updater() FROM PUBLIC;

-- The runner renames these three names to the install's (#1689).
SELECT caelo_grant_platform_updater('platform_updater', 'cms_admin', 'cms_public');
