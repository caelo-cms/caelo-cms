-- SPDX-License-Identifier: MPL-2.0
--
-- 0278 — public_role isolation on Cloud SQL (issue #633, CLAUDE.md §2).
--
-- On GCP `public_role` is a Cloud SQL Admin API user. Cloud SQL makes every
-- such user a member of `cloudsqlsuperuser` (the group that owns cms_admin
-- and cms_public) and gives it CREATEROLE + CREATEDB, and it leaves CONNECT
-- and TEMPORARY on both databases granted to PUBLIC — so the API gateway's
-- visitor-facing login could open cms_admin and act with the owner group's
-- rights.
--
-- The membership is removed by `cms-provision` through the Admin API
-- (`gcloud sql users assign-roles public_role --revoke-existing-roles`):
-- on PostgreSQL 16+ a membership can only be revoked by the role that
-- granted it, and Cloud SQL's own administrator granted this one, so a
-- REVOKE here would be a no-op with a warning. This migration does the
-- part SQL can do as the migration role:
--
--   1. CONNECT on each database only for the roles that use it, nothing for
--      PUBLIC. bootstrap.sh already does this on local, CI and self-hosted
--      databases; Cloud SQL never runs bootstrap.sh. admin_role may change
--      the database ACLs: it owns the databases locally and is a member of
--      the owning group on Cloud SQL.
--   2. Drop CREATEROLE / CREATEDB from public_role where the migration role
--      may alter it (CREATEROLE plus ADMIN OPTION on public_role). Where it
--      may not, the attributes stay and migrate.ts's role audit reports
--      them as a warning — without a privileged group neither reaches
--      existing data.
--
-- migrate.ts's role audit (src/role-audit.ts) then checks the outcome on
-- every run and fails the migration while public_role still belongs to
-- any group or can connect to cms_admin. Idempotent.

DO $$
DECLARE
  r text;
BEGIN
  -- Grant first, then revoke from PUBLIC: one transaction, so no role that
  -- uses a database ever loses CONNECT in between.
  FOREACH r IN ARRAY ARRAY['admin_role', 'gateway_role', 'operator_access_reader', 'platform_updater'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
    END IF;
  END LOOP;
  EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());

  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cms_public') THEN
    FOREACH r IN ARRAY ARRAY['admin_role', 'public_role', 'operator_access_reader', 'platform_updater'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT CONNECT ON DATABASE cms_public TO %I', r);
      END IF;
    END LOOP;
    REVOKE CONNECT, TEMPORARY ON DATABASE cms_public FROM PUBLIC;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_role' AND rolcreaterole) THEN
    BEGIN
      ALTER ROLE public_role NOCREATEROLE;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'public_role keeps CREATEROLE: % may not alter it (reported by the role audit)', current_user;
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_role' AND rolcreatedb) THEN
    BEGIN
      ALTER ROLE public_role NOCREATEDB;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'public_role keeps CREATEDB: % may not alter it (reported by the role audit)', current_user;
    END;
  END IF;
END
$$;
