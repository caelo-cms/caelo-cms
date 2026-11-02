-- SPDX-License-Identifier: MPL-2.0
--
-- 0500 — gateway hardening P1 + P8 (issues #1326, #1338; epic #763).
--
-- 1. Database limits on public_role, the public API gateway's only login
--    (#763 H3). The gateway is reachable from the internet without a WAF on
--    the cheap setup (E3), so the database itself bounds what a flood, or a
--    compromised gateway, can take from the one small server every
--    environment shares:
--
--      CONNECTION LIMIT 30            = DEFAULT_GATEWAY_MAX_INSTANCES (10)
--                                       × (GATEWAY_POOL_MAX 2 + 1 LISTEN),
--                                       the gateway's share of the pool
--                                       budget (@caelo-cms/shared
--                                       pool-budget.ts, which refuses a
--                                       scale-out above this limit, and a
--                                       test pins the two to each other).
--      statement_timeout 5s           no visitor request needs longer; the
--                                       advisory-lock wait of a hot rate-limit
--                                       bucket is bounded by it too.
--      idle_in_transaction_session_timeout 15s
--                                     a transaction left open cannot hold
--                                       locks or a connection.
--      work_mem 1MB                   × 30 connections stays far inside a
--                                       db-f1-micro's 614 MB.
--
--    ALTER ROLE needs the right to manage public_role. Cloud SQL's
--    migration role (a cloudsqlsuperuser member) has it. A local, CI or
--    self-hosted database gets the values from bootstrap.sh (superuser),
--    where admin_role has no CREATEROLE; the self-hosted upgrade re-runs
--    bootstrap.sh first. The role audit (src/role-audit.ts) fails the
--    migration run while public_role lacks any of them, so a database
--    where neither path reached it never serves silently unbounded.
--
-- 2. The live site origins the gateway accepts plugin posts from
--    (cms_public 0500 `published_gateway_settings.live_origins`) derive from
--    the base URL, the public domains and the staging host (which is never
--    one of them). Each of those writes marks the `settings` section, so
--    the projection republishes them right after the commit (0281).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_role') THEN
    BEGIN
      ALTER ROLE public_role CONNECTION LIMIT 30;
      ALTER ROLE public_role SET statement_timeout = '5s';
      ALTER ROLE public_role SET idle_in_transaction_session_timeout = '15s';
      ALTER ROLE public_role SET work_mem = '1MB';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'public_role limits not set: % may not alter it (bootstrap.sh sets them; the role audit checks)', current_user;
    END;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS caelo_projection_settings ON site_defaults;
CREATE TRIGGER caelo_projection_settings
  AFTER INSERT OR UPDATE OF site_base_url ON site_defaults FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('settings');

DROP TRIGGER IF EXISTS caelo_projection_settings ON domains;
CREATE TRIGGER caelo_projection_settings
  AFTER INSERT OR UPDATE OF hostname, kind OR DELETE ON domains FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('settings');

DROP TRIGGER IF EXISTS caelo_projection_settings ON staging_access;
CREATE TRIGGER caelo_projection_settings
  AFTER INSERT OR UPDATE OF staging_host OR DELETE ON staging_access FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('settings');
