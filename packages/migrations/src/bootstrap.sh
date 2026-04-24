#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
#
# Postgres bootstrap: creates two isolated roles + two databases per
# requirements §12. Single source of truth — used both by
# docker-entrypoint-initdb.d (first container boot, connects via Unix socket)
# and CI (connects via TCP to a service container).
#
# Idempotent: safe to re-run; existing roles/databases are skipped.
#
# Env vars:
#   POSTGRES_USER / POSTGRES_DB         — superuser creds (required)
#   ADMIN_ROLE_PASSWORD                 — required
#   PUBLIC_ROLE_PASSWORD                — required
#   PGHOST / PGPORT / PGPASSWORD        — optional; libpq picks them up so the
#                                         same script works for CI (TCP) and
#                                         initdb.d (socket) without code change.

set -e

: "${ADMIN_ROLE_PASSWORD:?must be set in environment}"
: "${PUBLIC_ROLE_PASSWORD:?must be set in environment}"

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

exists_db cms_admin  || $PSQL -c "CREATE DATABASE cms_admin OWNER admin_role;"
exists_db cms_public || $PSQL -c "CREATE DATABASE cms_public OWNER admin_role;"

$PSQL -c "REVOKE ALL ON DATABASE cms_admin  FROM PUBLIC;"
$PSQL -c "REVOKE ALL ON DATABASE cms_public FROM PUBLIC;"
$PSQL -c "GRANT CONNECT ON DATABASE cms_admin  TO admin_role;"
$PSQL -c "GRANT CONNECT ON DATABASE cms_public TO public_role, admin_role;"

# public_role gets zero default-schema privileges on cms_admin by omission;
# enforced by the role-isolation.integration.test suite.
