#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
#
# Postgres bootstrap: creates the isolated roles and databases per
# requirements §12: cms_admin (admin_role), cms_public (public_role, the
# live gateway) and cms_public_staging (public_staging_role, the staging
# gateway, #1329). Single source of truth — used both by
# docker-entrypoint-initdb.d (first container boot, connects via Unix socket)
# and CI (connects via TCP to a service container).
#
# Idempotent: safe to re-run; existing roles/databases are skipped.
#
# Env vars:
#   POSTGRES_USER / POSTGRES_DB         — superuser creds (required)
#   ADMIN_ROLE_PASSWORD                 — required
#   PUBLIC_ROLE_PASSWORD                — required
#   PUBLIC_STAGING_ROLE_PASSWORD        — required (#1329)
#   PGHOST / PGPORT / PGPASSWORD        — optional; libpq picks them up so the
#                                         same script works for CI (TCP) and
#                                         initdb.d (socket) without code change.

set -e

: "${ADMIN_ROLE_PASSWORD:?must be set in environment}"
: "${PUBLIC_ROLE_PASSWORD:?must be set in environment}"
: "${PUBLIC_STAGING_ROLE_PASSWORD:?must be set in environment}"

PSQL="psql -v ON_ERROR_STOP=1 --username ${POSTGRES_USER} --dbname ${POSTGRES_DB}"

# Run each DDL as its own invocation — psql -c / multi-statement stdin can
# wrap CREATE DATABASE in an implicit transaction, which Postgres rejects.
exists_role() {
  $PSQL -Atc "SELECT 1 FROM pg_roles WHERE rolname = '$1'" | grep -q 1
}
exists_db() {
  $PSQL -Atc "SELECT 1 FROM pg_database WHERE datname = '$1'" | grep -q 1
}

exists_role admin_role \
  || $PSQL -c "CREATE ROLE admin_role NOINHERIT LOGIN PASSWORD '${ADMIN_ROLE_PASSWORD}';"
exists_role public_role \
  || $PSQL -c "CREATE ROLE public_role NOINHERIT LOGIN PASSWORD '${PUBLIC_ROLE_PASSWORD}';"
# Issue #1329 — the staging gateway's only login, on cms_public_staging only.
exists_role public_staging_role \
  || $PSQL -c "CREATE ROLE public_staging_role NOINHERIT LOGIN PASSWORD '${PUBLIC_STAGING_ROLE_PASSWORD}';"

# Read-only role of the operator-access sync job (migration 0239 grants it
# its columns). Created here because the local admin_role has no CREATEROLE;
# on Cloud SQL the migration creates it. admin_role may SET ROLE to it so the
# integration tests can prove what the role can and cannot do.
exists_role operator_access_reader \
  || $PSQL -c "CREATE ROLE operator_access_reader NOLOGIN;"
$PSQL -c "GRANT operator_access_reader TO admin_role;"

# The upgrader job's role (migration 0267 grants it exactly the update
# request/event/policy columns it may touch). Same reason as above: created
# here because the local admin_role has no CREATEROLE; admin_role may SET
# ROLE to it so the integration tests can prove its limits.
exists_role platform_updater \
  || $PSQL -c "CREATE ROLE platform_updater NOLOGIN;"
$PSQL -c "GRANT platform_updater TO admin_role;"

exists_db cms_admin  || $PSQL -c "CREATE DATABASE cms_admin OWNER admin_role;"
exists_db cms_public || $PSQL -c "CREATE DATABASE cms_public OWNER admin_role;"
exists_db cms_public_staging || $PSQL -c "CREATE DATABASE cms_public_staging OWNER admin_role;"

$PSQL -c "REVOKE ALL ON DATABASE cms_admin  FROM PUBLIC;"
$PSQL -c "REVOKE ALL ON DATABASE cms_public FROM PUBLIC;"
$PSQL -c "REVOKE ALL ON DATABASE cms_public_staging FROM PUBLIC;"
$PSQL -c "GRANT CONNECT ON DATABASE cms_admin  TO admin_role;"
$PSQL -c "GRANT CONNECT ON DATABASE cms_public TO public_role, admin_role;"
$PSQL -c "GRANT CONNECT ON DATABASE cms_public_staging TO public_staging_role, admin_role;"
# Each gateway's login reaches its own database only (#1329): a database
# from before carries no such grant, but a hand-made one might.
$PSQL -c "REVOKE ALL ON DATABASE cms_public_staging FROM public_role;"
$PSQL -c "REVOKE ALL ON DATABASE cms_public FROM public_staging_role;"

# public_role gets zero default-schema privileges on cms_admin by omission;
# enforced by the role-isolation.integration.test suite.

# Issue #1338 — the database bounds what the public gateway's login may take
# (values and reasons: cms_admin migration 0500, which sets them where the
# migration role may; here admin_role has no CREATEROLE). The role audit
# fails the migrations while one is missing. Re-run on every self-hosted
# upgrade, so a value changed here reaches existing installs.
$PSQL -c "ALTER ROLE public_role CONNECTION LIMIT 30;"
$PSQL -c "ALTER ROLE public_role SET statement_timeout = '5s';"
$PSQL -c "ALTER ROLE public_role SET idle_in_transaction_session_timeout = '15s';"
$PSQL -c "ALTER ROLE public_role SET work_mem = '1MB';"
# Issue #1329 — the staging gateway's login gets the same bounds (cms_admin
# migration 0530).
$PSQL -c "ALTER ROLE public_staging_role CONNECTION LIMIT 30;"
$PSQL -c "ALTER ROLE public_staging_role SET statement_timeout = '5s';"
$PSQL -c "ALTER ROLE public_staging_role SET idle_in_transaction_session_timeout = '15s';"
$PSQL -c "ALTER ROLE public_staging_role SET work_mem = '1MB';"

# Issue #635 — the API gateway has no cms_admin login any more. A database
# from before still holds the former gateway_role; migration 0285 strips its
# grants but cannot drop a role the superuser created. Drop it here, with
# whatever it still holds in either database.
if exists_role gateway_role; then
  $PSQL -d cms_admin -c "DROP OWNED BY gateway_role;"
  $PSQL -d cms_public -c "DROP OWNED BY gateway_role;"
  $PSQL -d cms_public_staging -c "DROP OWNED BY gateway_role;"
  $PSQL -c "DROP ROLE gateway_role;"
fi
