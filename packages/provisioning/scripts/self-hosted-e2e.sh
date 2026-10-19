#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# End-to-end check of the self-hosted one-command install (#566, #707)
# against a throwaway Compose project:
#
#   1. `cms-provision --provider self-hosted …` from this checkout installs a
#      released Caelo (cosign-verified images) and must come up healthy;
#   2. the admin, the gateway (`/api/*`) and the static site answer THROUGH
#      Caddy (no 502), incl. a real 404 page and the staging noindex header;
#   3. `backup`, a change, `restore` — the change is gone, the backup's state
#      is back, everything serves again;
#   4. everything the run created is removed (only its own Compose project).
#
# It never touches another Compose project: a unique domain (the Compose
# project name, `name:` in the generated file, derives from it), free
# ports, its own temp dir. TLS comes from Caddy's local CA (`--tls
# internal`) because ACME cannot issue certificates for a test host.
#
# Usage: packages/provisioning/scripts/self-hosted-e2e.sh <release version>
# Needs: docker (with compose), bun, cosign, curl, openssl.

set -euo pipefail

VERSION="${1:?usage: self-hosted-e2e.sh <release version, e.g. 0.10.49>}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI="$REPO/packages/provisioning/src/cli.ts"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/caelo-selfhosted-e2e.XXXXXX")"
DOMAIN="e2e-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n').test"
export CAELO_SELF_HOSTED_DIR="$WORK/.caelo"
# The generated file names its project; an inherited override would hide that.
unset COMPOSE_PROJECT_NAME
# The release images are linux/amd64 only; on an arm64 host Docker runs them emulated.
if [ "$(uname -m)" = "arm64" ] || [ "$(uname -m)" = "aarch64" ]; then
  export DOCKER_DEFAULT_PLATFORM=linux/amd64
fi

free_port() {
  bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true);'
}
HTTP_PORT="$(free_port)"
HTTPS_PORT="$(free_port)"

dc() { docker compose -f "$CAELO_SELF_HOSTED_DIR/docker-compose.yml" "$@"; }
cleanup() {
  if [ -f "$CAELO_SELF_HOSTED_DIR/docker-compose.yml" ]; then
    dc down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK" 2>/dev/null || echo "note: could not remove $WORK (files written by the containers)"
}
trap cleanup EXIT

RESOLVE=()
for host in "admin.$DOMAIN" "$DOMAIN" "staging.$DOMAIN"; do
  RESOLVE+=(--resolve "$host:$HTTPS_PORT:127.0.0.1")
done
fail() { echo "FAIL: $*" >&2; exit 1; }
# expect <status> <url> [body substring]
expect() {
  local body status
  body="$(curl -sk "${RESOLVE[@]}" -w '\n%{http_code}' "$2")"
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  [ "$status" = "$1" ] || fail "$2 answered $status, expected $1: ${body:0:300}"
  if [ -n "${3:-}" ] && [[ "$body" != *"$3"* ]]; then fail "$2 does not contain '$3': ${body:0:300}"; fi
  echo "ok  $status $2"
}
psql_admin() { dc exec -T postgres psql -U caelo -d cms_admin -Atc "$1"; }

echo "==> domain $DOMAIN, ports $HTTP_PORT/$HTTPS_PORT, dir $WORK"
cd "$WORK"
bun "$CLI" --provider self-hosted --domain "$DOMAIN" --owner-email e2e@example.com \
  --version "$VERSION" --tls internal --http-port "$HTTP_PORT" --https-port "$HTTPS_PORT"

ADMIN="https://admin.$DOMAIN:$HTTPS_PORT"
SITE="https://$DOMAIN:$HTTPS_PORT"
STAGING="https://staging.$DOMAIN:$HTTPS_PORT"

# A published build where the admin's deploy writes one (deploy target
# out_dir `output/<env>` under CAELO_OUTPUT_ROOT = the host's .caelo/output).
OUT="$CAELO_SELF_HOSTED_DIR/output/output"
# (`current/` is a directory the generator syncs in place.)
mkdir -p "$OUT/production/current/about" "$OUT/staging/current"
echo "<h1>e2e home</h1>" >"$OUT/production/current/index.html"
echo "<h1>e2e about</h1>" >"$OUT/production/current/about/index.html"
echo "<h1>e2e not found</h1>" >"$OUT/production/current/404.html"
echo "<h1>e2e staging</h1>" >"$OUT/staging/current/index.html"

check_serving() {
  expect 200 "$ADMIN/_caelo/health" '"ok":true'
  expect 200 "$ADMIN/setup"
  expect 200 "$SITE/api/_caelo/health" '"ok":true'
  expect 200 "$STAGING/api/_caelo/health" '"ok":true'
  expect 200 "$SITE/" "e2e home"
  expect 200 "$SITE/about" "e2e about"
  expect 404 "$SITE/does-not-exist" "e2e not found"
  curl -sk "${RESOLVE[@]}" -D - -o /dev/null "$STAGING/" | grep -qi '^x-robots-tag: noindex' ||
    fail "staging has no X-Robots-Tag: noindex"
  echo "ok  staging noindex"
}
check_serving
PROJECT="$(dc config --format json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).name)')"
[ "$(docker ps --filter "label=com.docker.compose.project=$PROJECT" -q | wc -l | tr -d ' ')" = 4 ] ||
  fail "the containers are not in the install's own Compose project $PROJECT"
echo "ok  compose project $PROJECT"
[ "$(psql_admin "select count(*) from pg_roles where rolname in ('admin_role','public_role')")" = 2 ] ||
  fail "bootstrap.sh did not create the application roles"
# #635 — the gateway has no cms_admin login: the former gateway_role is gone.
[ "$(psql_admin "select count(*) from pg_roles where rolname = 'gateway_role'")" = 0 ] ||
  fail "the former gateway_role still exists"
echo "ok  roles"

echo "==> backup / change / restore"
psql_admin "insert into domains (hostname, kind) values ('before-backup.test', 'public')" >/dev/null
echo before >"$CAELO_SELF_HOSTED_DIR/media/before-backup.txt"
bun "$CLI" backup --to "$WORK/backup.tar.gz"
psql_admin "delete from domains where hostname = 'before-backup.test'" >/dev/null
psql_admin "insert into domains (hostname, kind) values ('after-backup.test', 'public')" >/dev/null
rm "$CAELO_SELF_HOSTED_DIR/media/before-backup.txt"
echo "<h1>changed</h1>" >"$OUT/production/current/index.html"
bun "$CLI" restore --from "$WORK/backup.tar.gz" --yes
[ "$(psql_admin "select string_agg(hostname, ',' order by hostname) from domains")" = "before-backup.test" ] ||
  fail "the database was not restored"
[ -f "$CAELO_SELF_HOSTED_DIR/media/before-backup.txt" ] || fail "the media were not restored"
grep -q "^before-backup.test {" "$CAELO_SELF_HOSTED_DIR/Caddyfile" ||
  fail "the Caddyfile was not re-rendered from the restored domains"
echo "ok  restored database, media and Caddy vhosts"
check_serving

echo "PASS: self-hosted install, Caddy routing and backup/restore ($PROJECT)"
