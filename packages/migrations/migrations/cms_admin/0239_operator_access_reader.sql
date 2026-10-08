-- SPDX-License-Identifier: MPL-2.0
--
-- 0239 — `operator_access_reader`: the read-only database role of the
-- operator-access sync job (packages/admin-core/src/security/operator-access/
-- sync-job.ts).
--
-- On Google IAP installs a Cloud Run job with its own service account is the
-- only principal that may change who passes IAP. It reads the user list with
-- Cloud SQL IAM database authentication as a member of this role, which can
-- SELECT exactly the columns `users.operator_access_members` touches — no
-- password hashes, no sessions, no writes anywhere.
--
-- Creating a role needs CREATEROLE. Cloud SQL's admin_role has it (built-in
-- users are members of cloudsqlsuperuser), so the role is created here on
-- GCP. Locally and in CI bootstrap.sh creates it as the superuser. A
-- self-hosted install whose admin_role lacks CREATEROLE has no sync job (it
-- is not behind IAP), so this migration then grants nothing instead of
-- failing the upgrade.
--
-- The IAM user is made a member by `gcloud sql users assign-roles`
-- (packages/provisioning/src/operator-access.ts), after this migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operator_access_reader')
     AND (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    CREATE ROLE operator_access_reader NOLOGIN;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'operator_access_reader') THEN
    EXECUTE 'GRANT CONNECT ON DATABASE cms_admin TO operator_access_reader';
    -- The query API opens a cms_public pool too and verifies its identity;
    -- the role reads nothing there.
    EXECUTE 'GRANT CONNECT ON DATABASE cms_public TO operator_access_reader';
    EXECUTE 'GRANT USAGE ON SCHEMA public TO operator_access_reader';
    EXECUTE 'GRANT SELECT (id, email, deleted_at) ON users TO operator_access_reader';
    EXECUTE 'GRANT SELECT (user_id) ON user_roles TO operator_access_reader';
    -- users RLS is self-or-system; this read-only policy lets the role see
    -- every row without depending on the session's caelo.actor_kind.
    EXECUTE 'DROP POLICY IF EXISTS users_operator_access_read ON users';
    EXECUTE 'CREATE POLICY users_operator_access_read ON users FOR SELECT TO operator_access_reader USING (true)';
  END IF;
END
$$;
