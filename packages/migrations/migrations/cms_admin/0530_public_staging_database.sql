-- SPDX-License-Identifier: MPL-2.0
--
-- 0530 — the staging database and its gateway login (issue #1329, gateway
-- hardening P3b-1, epic #763 E10).
--
-- Staging gets data of its own: `cms_public_staging`, a twin of cms_public
-- (the same cms_public migrations, migrate.ts `public-staging`), reached by
-- the staging gateway as `public_staging_role` and by nothing of the live
-- side. The database and the role are created where the platform creates
-- them — bootstrap.sh (local, CI, self-hosted: self-hosted-roles.ts) and
-- the Cloud SQL Admin API (the stacks, and the converge for an existing
-- install, staging-database.ts) — before this migration runs. This
-- migration does the part SQL does as the migration role, like 0278 and
-- 0500 do for cms_public and public_role:
--
--   1. CONNECT on cms_public_staging only for admin_role and
--      public_staging_role, nothing for PUBLIC (Cloud SQL leaves CONNECT and
--      TEMPORARY granted to PUBLIC on every database it creates), and
--      neither gateway login on the other's database.
--   2. public_staging_role gets the same bounds as public_role (0500): the
--      staging gateway is reachable from the internet like the live one and
--      shares the one small server with every environment.
--
--        CONNECTION LIMIT 30, statement_timeout 5s,
--        idle_in_transaction_session_timeout 15s, work_mem 1MB
--
--      plus NOCREATEROLE / NOCREATEDB (the Admin API grants both).
--
-- ALTER ROLE needs the right to manage the role: Cloud SQL's migration role
-- has it, a local or self-hosted admin_role does not (bootstrap.sh and
-- self-hosted-roles.ts set the same values as the superuser). The role
-- audit (src/role-audit.ts) fails the run while any of it is missing:
-- public_staging_role without its limits, a gateway login that can open
-- the other environment's database, PUBLIC with CONNECT on any of them.
-- Idempotent.

DO $$
DECLARE
  r text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cms_public_staging') THEN
    RAISE EXCEPTION 'cms_public_staging does not exist (#1329): the install creates it before migrating. Cloud installs: run `cms-provision upgrade` (or Install update for this release); self-hosted: `cms-provision up`; local: re-run packages/migrations/src/bootstrap.sh as the superuser.';
  END IF;
  -- Grant first, then revoke from PUBLIC: one transaction, so no role that
  -- uses the database ever loses CONNECT in between.
  FOREACH r IN ARRAY ARRAY['admin_role', 'public_staging_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      -- caelo:dynamic-grantee r iterates the literal array above: the admin and the staging gateway's own login, on the staging database only.
      EXECUTE format('GRANT CONNECT ON DATABASE cms_public_staging TO %I', r);
    END IF;
  END LOOP;
  REVOKE CONNECT, TEMPORARY ON DATABASE cms_public_staging FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_role') THEN
    REVOKE ALL ON DATABASE cms_public_staging FROM public_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_staging_role') THEN
    REVOKE ALL ON DATABASE cms_public FROM public_staging_role;
    REVOKE ALL ON DATABASE cms_admin FROM public_staging_role;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_staging_role') THEN
    BEGIN
      ALTER ROLE public_staging_role CONNECTION LIMIT 30;
      ALTER ROLE public_staging_role SET statement_timeout = '5s';
      ALTER ROLE public_staging_role SET idle_in_transaction_session_timeout = '15s';
      ALTER ROLE public_staging_role SET work_mem = '1MB';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'public_staging_role limits not set: % may not alter it (bootstrap.sh sets them; the role audit checks)', current_user;
    END;
    BEGIN
      ALTER ROLE public_staging_role NOCREATEROLE NOCREATEDB;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'public_staging_role keeps CREATEROLE / CREATEDB: % may not alter it (reported by the role audit)', current_user;
    END;
  END IF;
END
$$;
