#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
#
# Postgres first-run bootstrap. Runs once when the container's data volume is empty
# (mounted into /docker-entrypoint-initdb.d/). Creates two isolated roles + two
# databases per requirements §12. Subsequent container restarts skip this script.

set -e

: "${ADMIN_ROLE_PASSWORD:?must be set in environment}"
: "${PUBLIC_ROLE_PASSWORD:?must be set in environment}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- Two isolated login roles. NOINHERIT so they never pick up privileges via group membership.
  CREATE ROLE admin_role NOINHERIT LOGIN PASSWORD '$ADMIN_ROLE_PASSWORD';
  CREATE ROLE public_role NOINHERIT LOGIN PASSWORD '$PUBLIC_ROLE_PASSWORD';

  -- Two databases, admin_role owns both so it can run DDL. Application connection pool
  -- for cms_public uses public_role (never admin_role) once migrations have granted
  -- per-table INSERT privileges.
  CREATE DATABASE cms_admin OWNER admin_role;
  CREATE DATABASE cms_public OWNER admin_role;

  -- Lock down default privileges on both databases.
  REVOKE ALL ON DATABASE cms_admin FROM PUBLIC;
  REVOKE ALL ON DATABASE cms_public FROM PUBLIC;

  GRANT CONNECT ON DATABASE cms_admin TO admin_role;
  GRANT CONNECT ON DATABASE cms_public TO public_role, admin_role;
EOSQL

# public_role gets zero default-schema privileges on cms_admin by omission; enforced
# by the role-isolation.integration.test suite.
