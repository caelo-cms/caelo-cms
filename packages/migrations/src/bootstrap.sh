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
# Issue #1689 — with CAELO_INSTALL_NAMES set (the install's name map, JSON,
# @caelo-cms/shared install-names.ts) it creates that install's roles and
# databases instead, so several installs can share one server: run it once
# per install. Every database is closed to PUBLIC and opened to the
# install's own roles only.
#
# Idempotent: safe to re-run; existing roles/databases are skipped.
#
# Env vars:
#   POSTGRES_USER / POSTGRES_DB         — superuser creds (required)
#   ADMIN_ROLE_PASSWORD                 — required
#   PUBLIC_ROLE_PASSWORD                — required
#   PUBLIC_STAGING_ROLE_PASSWORD        — required (#1329)
#   CAELO_INSTALL_NAMES                 — optional (#1689): the install's
#                                         role and database names; today's
#                                         names when unset
#   ADMIN_ROLE_CONNECTION_LIMIT         — optional (#1689): the admin
#                                         login's CONNECTION LIMIT, for an
#                                         install that shares its server;
#                                         unlimited when unset
#   PGHOST / PGPORT / PGPASSWORD        — optional; libpq picks them up so the
#                                         same script works for CI (TCP) and
#                                         initdb.d (socket) without code change.

set -e

: "${ADMIN_ROLE_PASSWORD:?must be set in environment}"
: "${PUBLIC_ROLE_PASSWORD:?must be set in environment}"
: "${PUBLIC_STAGING_ROLE_PASSWORD:?must be set in environment}"

PSQL="psql -v ON_ERROR_STOP=1 --username ${POSTGRES_USER} --dbname ${POSTGRES_DB}"

# One name of the map at `path` (e.g. roles,admin). psql parses the JSON —
# the postgres image has no jq — and the map reaches it as a psql variable,
# which :'names' quotes. Only a plain identifier comes back, outside the
# prefixes install-names.ts reserves and no keyword this server would need
# quoted (pg_get_keywords, as install-names.ts), and no role named public,
# which Postgres reserves for its PUBLIC pseudo-role: every name is spliced
# into the statements below.
install_name() {
  printf "%s\n" "SELECT CASE WHEN v ~ '^[a-z_][a-z0-9_]{0,62}\$' AND v !~ '^(pg_|cloudsql|rds_|rdsadmin|azure_)' AND v NOT IN (SELECT word FROM pg_get_keywords() WHERE catcode <> 'U') AND ('$1' NOT LIKE 'roles,%' OR v <> 'public') THEN v END FROM (SELECT (:'names')::jsonb #>> '{$1}' AS v) s;" \
    | $PSQL -v names="${CAELO_INSTALL_NAMES}" -At
}
# Fail unless every argument differs from every other one: two slots with
# one name would make a statement below act on the wrong role (the former
# gateway role's DROP OWNED on the admin role), so the whole map is checked
# before the first statement runs, not only by migrate.ts afterwards.
all_different() {
  kind=$1
  shift
  dup=$(printf "%s\n" "$@" | sort | uniq -d | head -n 1)
  if [ -n "$dup" ]; then
    echo "bootstrap.sh: CAELO_INSTALL_NAMES names two ${kind} \"${dup}\" (#1689: every one has a name of its own); nothing was changed" >&2
    exit 1
  fi
}
name_or_fail() {
  value=$(install_name "$1")
  if [ -z "$value" ]; then
    echo "bootstrap.sh: CAELO_INSTALL_NAMES has no valid name at $1 (#1689: a lower-case identifier that is no Postgres keyword, every name set)" >&2
    exit 1
  fi
  printf "%s" "$value"
}

if [ -n "${CAELO_INSTALL_NAMES}" ]; then
  ADMIN_ROLE=$(name_or_fail roles,admin)
  PUBLIC_ROLE=$(name_or_fail roles,public)
  STAGING_ROLE=$(name_or_fail roles,publicStaging)
  READER_ROLE=$(name_or_fail roles,operatorAccessReader)
  UPDATER_ROLE=$(name_or_fail roles,platformUpdater)
  GATEWAY_ROLE=$(name_or_fail roles,formerGateway)
  ADMIN_DB=$(name_or_fail databases,admin)
  PUBLIC_DB=$(name_or_fail databases,public)
  STAGING_DB=$(name_or_fail databases,publicStaging)
  all_different roles "${ADMIN_ROLE}" "${PUBLIC_ROLE}" "${STAGING_ROLE}" "${READER_ROLE}" "${UPDATER_ROLE}" "${GATEWAY_ROLE}"
  all_different databases "${ADMIN_DB}" "${PUBLIC_DB}" "${STAGING_DB}"
else
  ADMIN_ROLE=admin_role
  PUBLIC_ROLE=public_role
  STAGING_ROLE=public_staging_role
  READER_ROLE=operator_access_reader
  UPDATER_ROLE=platform_updater
  GATEWAY_ROLE=gateway_role
  ADMIN_DB=cms_admin
  PUBLIC_DB=cms_public
  STAGING_DB=cms_public_staging
fi

# Run each DDL as its own invocation — psql -c / multi-statement stdin can
# wrap CREATE DATABASE in an implicit transaction, which Postgres rejects.
exists_role() {
  $PSQL -Atc "SELECT 1 FROM pg_roles WHERE rolname = '$1'" | grep -q 1
}
exists_db() {
  $PSQL -Atc "SELECT 1 FROM pg_database WHERE datname = '$1'" | grep -q 1
}

exists_role "${ADMIN_ROLE}" \
  || $PSQL -c "CREATE ROLE ${ADMIN_ROLE} NOINHERIT LOGIN PASSWORD '${ADMIN_ROLE_PASSWORD}';"
exists_role "${PUBLIC_ROLE}" \
  || $PSQL -c "CREATE ROLE ${PUBLIC_ROLE} NOINHERIT LOGIN PASSWORD '${PUBLIC_ROLE_PASSWORD}';"
# Issue #1329 — the staging gateway's only login, on cms_public_staging only.
exists_role "${STAGING_ROLE}" \
  || $PSQL -c "CREATE ROLE ${STAGING_ROLE} NOINHERIT LOGIN PASSWORD '${PUBLIC_STAGING_ROLE_PASSWORD}';"

# Read-only role of the operator-access sync job (migration 0239 grants it
# its columns). Created here because the local admin_role has no CREATEROLE;
# on Cloud SQL the migration creates it. admin_role may SET ROLE to it so the
# integration tests can prove what the role can and cannot do.
exists_role "${READER_ROLE}" \
  || $PSQL -c "CREATE ROLE ${READER_ROLE} NOLOGIN;"
$PSQL -c "GRANT ${READER_ROLE} TO ${ADMIN_ROLE};"

# The upgrader job's role (migration 0267 grants it exactly the update
# request/event/policy columns it may touch). Same reason as above: created
# here because the local admin_role has no CREATEROLE; admin_role may SET
# ROLE to it so the integration tests can prove its limits.
exists_role "${UPDATER_ROLE}" \
  || $PSQL -c "CREATE ROLE ${UPDATER_ROLE} NOLOGIN;"
$PSQL -c "GRANT ${UPDATER_ROLE} TO ${ADMIN_ROLE};"

# Issue #1689 — a new database lets every login connect until PUBLIC's
# CONNECT is revoked, and a REVOKE ends no session that got in before it.
# On a server several installs share, another install's login could slip in
# between the two statements and stay. So each database is created refusing
# every connection and opened only once it is closed to PUBLIC (below).
exists_db "${ADMIN_DB}"  || $PSQL -c "CREATE DATABASE ${ADMIN_DB} OWNER ${ADMIN_ROLE} ALLOW_CONNECTIONS false;"
exists_db "${PUBLIC_DB}" || $PSQL -c "CREATE DATABASE ${PUBLIC_DB} OWNER ${ADMIN_ROLE} ALLOW_CONNECTIONS false;"
exists_db "${STAGING_DB}" || $PSQL -c "CREATE DATABASE ${STAGING_DB} OWNER ${ADMIN_ROLE} ALLOW_CONNECTIONS false;"

$PSQL -c "REVOKE ALL ON DATABASE ${ADMIN_DB}  FROM PUBLIC;"
$PSQL -c "REVOKE ALL ON DATABASE ${PUBLIC_DB} FROM PUBLIC;"
$PSQL -c "REVOKE ALL ON DATABASE ${STAGING_DB} FROM PUBLIC;"
$PSQL -c "GRANT CONNECT ON DATABASE ${ADMIN_DB}  TO ${ADMIN_ROLE};"
$PSQL -c "GRANT CONNECT ON DATABASE ${PUBLIC_DB} TO ${PUBLIC_ROLE}, ${ADMIN_ROLE};"
$PSQL -c "GRANT CONNECT ON DATABASE ${STAGING_DB} TO ${STAGING_ROLE}, ${ADMIN_ROLE};"
# Each gateway's login reaches its own database only (#1329): a database
# from before carries no such grant, but a hand-made one might.
$PSQL -c "REVOKE ALL ON DATABASE ${STAGING_DB} FROM ${PUBLIC_ROLE};"
$PSQL -c "REVOKE ALL ON DATABASE ${PUBLIC_DB} FROM ${STAGING_ROLE};"
# Closed now: open them (a no-op on a database from before, and it opens one
# a run that stopped after the CREATE DATABASE left closed).
$PSQL -c "ALTER DATABASE ${ADMIN_DB} ALLOW_CONNECTIONS true;"
$PSQL -c "ALTER DATABASE ${PUBLIC_DB} ALLOW_CONNECTIONS true;"
$PSQL -c "ALTER DATABASE ${STAGING_DB} ALLOW_CONNECTIONS true;"

# Issue #1689 — pg_trgm (cms_admin migration 0024) belongs to the
# superuser, not to the admin role: ALTER EXTENSION has no OWNER TO, so an
# extension the admin role owned would tie a template copy of this
# database to the template's role (install-from-template.ts). The
# migration's CREATE EXTENSION IF NOT EXISTS then finds it. A database
# from before keeps the admin role's pg_trgm; only a template needs this.
$PSQL -d "${ADMIN_DB}" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

# public_role gets zero default-schema privileges on cms_admin by omission;
# enforced by the role-isolation.integration.test suite.

# Issue #1338 — the database bounds what the public gateway's login may take
# (values and reasons: cms_admin migration 0500, which sets them where the
# migration role may; here admin_role has no CREATEROLE). The role audit
# fails the migrations while one is missing. Re-run on every self-hosted
# upgrade, so a value changed here reaches existing installs.
$PSQL -c "ALTER ROLE ${PUBLIC_ROLE} CONNECTION LIMIT 30;"
$PSQL -c "ALTER ROLE ${PUBLIC_ROLE} SET statement_timeout = '5s';"
$PSQL -c "ALTER ROLE ${PUBLIC_ROLE} SET idle_in_transaction_session_timeout = '15s';"
$PSQL -c "ALTER ROLE ${PUBLIC_ROLE} SET work_mem = '1MB';"
# Issue #1329 — the staging gateway's login gets the same bounds (cms_admin
# migration 0530).
$PSQL -c "ALTER ROLE ${STAGING_ROLE} CONNECTION LIMIT 30;"
$PSQL -c "ALTER ROLE ${STAGING_ROLE} SET statement_timeout = '5s';"
$PSQL -c "ALTER ROLE ${STAGING_ROLE} SET idle_in_transaction_session_timeout = '15s';"
$PSQL -c "ALTER ROLE ${STAGING_ROLE} SET work_mem = '1MB';"

# Issue #1689 — on a server several installs share, the admin login is
# bounded too, so one install cannot take every connection of the server.
if [ -n "${ADMIN_ROLE_CONNECTION_LIMIT}" ]; then
  case "${ADMIN_ROLE_CONNECTION_LIMIT}" in
    *[!0-9]*)
      echo "bootstrap.sh: ADMIN_ROLE_CONNECTION_LIMIT must be a whole number (got ${ADMIN_ROLE_CONNECTION_LIMIT})" >&2
      exit 1
      ;;
  esac
  $PSQL -c "ALTER ROLE ${ADMIN_ROLE} CONNECTION LIMIT ${ADMIN_ROLE_CONNECTION_LIMIT};"
fi

# Issue #635 — the API gateway has no cms_admin login any more. A database
# from before still holds the former gateway_role; migration 0285 strips its
# grants but cannot drop a role the superuser created. Drop it here, with
# whatever it still holds in either database.
if exists_role "${GATEWAY_ROLE}"; then
  $PSQL -d "${ADMIN_DB}" -c "DROP OWNED BY ${GATEWAY_ROLE};"
  $PSQL -d "${PUBLIC_DB}" -c "DROP OWNED BY ${GATEWAY_ROLE};"
  $PSQL -d "${STAGING_DB}" -c "DROP OWNED BY ${GATEWAY_ROLE};"
  $PSQL -c "DROP ROLE ${GATEWAY_ROLE};"
fi
