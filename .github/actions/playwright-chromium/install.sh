#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Installs Playwright's Chromium plus the system packages it needs, without
# depending on the Ubuntu apt mirror on every run (issue #984).
#
# Why: `playwright install chromium --with-deps` runs `apt-get install` for
# the whole dependency list. On the GitHub ubuntu-24.04 image every library is
# already present; what is missing are fonts (fonts-ipafont-gothic,
# fonts-wqy-zenhei, fonts-unifont, ...) plus their xfonts helpers. Downloading
# those ~20 MB from azure.archive.ubuntu.com regularly took 10-16 minutes and
# cancelled jobs on timeout. The fonts must stay: screenshot and a11y
# rendering depend on them.
#
# How: the `plan` command asks Playwright which of its declared packages are
# not installed on this runner (`install-deps --dry-run`, a no-root apt
# simulation) and keeps only the ones with no installed version at all -
# upgrades of libraries the image already ships are not needed to run
# Chromium. That exact set names the cache key, so a runner image that starts
# (or stops) shipping a package gets a new key instead of a stale cache.
# The `install` command then installs those .deb files offline with dpkg on a
# cache hit, or runs the original `--with-deps` path once on a miss and copies
# the .deb files of that set into the cache directory for the save step.
#
# Usage: install.sh plan|install
#   env: DEB_DIR, PLAYWRIGHT_CLI; NEEDED, CACHE_HIT (install only)

set -euo pipefail

: "${DEB_DIR:?DEB_DIR must point at the .deb cache directory}"
: "${PLAYWRIGHT_CLI:?PLAYWRIGHT_CLI must point at the repo-pinned playwright cli.js}"

STATE_DIR="${RUNNER_TEMP:-/tmp}/playwright-chromium"
MISSING_FILE="$STATE_DIR/missing-packages.txt"
mkdir -p "$STATE_DIR"

playwright() {
  bun "$PLAYWRIGHT_CLI" "$@"
}

# Prints the Playwright-declared packages for chromium that have no installed
# version on this machine, one per line, sorted. Exits non-zero when the apt
# simulation itself fails (e.g. no package lists on the image).
list_missing_packages() {
  local out status=0
  out="$(playwright install-deps --dry-run chromium 2>&1)" || status=$?
  if [[ "$out" == *"All system dependencies are installed."* ]]; then
    return 0
  fi
  if [[ $status -ne 0 && "$out" != *"Missing system dependencies"* ]]; then
    echo "$out" >&2
    return 1
  fi
  local pkg
  # Lines after the "Missing system dependencies (N):" header are "  <pkg>".
  sed -n 's/^  \([a-z0-9][a-z0-9.+-]*\)$/\1/p' <<<"$out" | while read -r pkg; do
    if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" != "installed" ]]; then
      echo "$pkg"
    fi
  done | sort -u
}

cmd_plan() {
  local version digest
  version="$(jq -r .version "$(dirname "$PLAYWRIGHT_CLI")/package.json")"
  if ! list_missing_packages >"$MISSING_FILE"; then
    # No usable apt simulation: we cannot tell what to cache, so `install`
    # takes the uncached `--with-deps` path and the cache is left alone.
    echo "::warning::apt simulation failed; installing Playwright deps from the Ubuntu mirror"
    echo "needed=unknown" >>"$GITHUB_OUTPUT"
    echo "key=playwright-apt-debs-unplanned" >>"$GITHUB_OUTPUT"
    return 0
  fi
  echo "Playwright $version; packages missing on this runner:"
  sed 's/^/  /' "$MISSING_FILE"
  digest="$(sha256sum <"$MISSING_FILE" | cut -c1-16)"
  echo "key=playwright-apt-debs-${RUNNER_OS:-os}-${RUNNER_ARCH:-arch}-${ImageOS:-image}-${version}-${digest}" >>"$GITHUB_OUTPUT"
  if [[ -s "$MISSING_FILE" ]]; then
    echo "needed=true" >>"$GITHUB_OUTPUT"
  else
    echo "needed=false" >>"$GITHUB_OUTPUT"
  fi
}

# Installs the cached .deb files offline. Returns non-zero when the cache does
# not cover every missing package, so the caller falls back to apt.
install_from_cache() {
  shopt -s nullglob
  local debs=("$DEB_DIR"/*.deb)
  shopt -u nullglob
  [[ ${#debs[@]} -gt 0 ]] || return 1
  echo "Installing ${#debs[@]} cached .deb files offline"
  sudo dpkg -i "${debs[@]}" || return 1
  # The cache key is the hash of the planned set, so checking that set is
  # enough; no second apt simulation needed.
  local pkg
  while read -r pkg; do
    [[ -n "$pkg" ]] || continue
    if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null || true)" != "installed" ]]; then
      echo "Cache did not cover: $pkg" >&2
      return 1
    fi
  done <"$MISSING_FILE"
}

# The original path, run once per cache key: apt installs from the mirror.
# Afterwards the .deb files of the missing set are copied for the save step.
install_from_mirror_and_collect() {
  playwright install chromium --with-deps
  mkdir -p "$DEB_DIR"
  local pkg
  local -a debs
  shopt -s nullglob
  while read -r pkg; do
    [[ -n "$pkg" ]] || continue
    debs=(/var/cache/apt/archives/"${pkg}"_*.deb)
    if [[ ${#debs[@]} -gt 0 ]]; then
      cp "${debs[0]}" "$DEB_DIR/"
    else
      # apt-get removed it after installing (Keep-Downloaded-Packages=false).
      (cd "$DEB_DIR" && apt-get download "$pkg")
    fi
  done <"$MISSING_FILE"
  shopt -u nullglob
  echo "populated=true" >>"$GITHUB_OUTPUT"
}

cmd_install() {
  case "${NEEDED:?NEEDED must be the needed output of the plan step}" in
    false)
      echo "All Chromium system packages already installed on this runner"
      ;;
    unknown)
      playwright install chromium --with-deps
      return 0
      ;;
    true)
      if [[ "${CACHE_HIT:-false}" == "true" ]] && install_from_cache; then
        echo "System packages installed offline from the cache"
      else
        echo "::notice::Playwright apt cache miss; installing from the Ubuntu mirror once to fill the cache"
        rm -rf "$DEB_DIR"
        install_from_mirror_and_collect
        return 0
      fi
      ;;
  esac
  playwright install chromium
}

case "${1:-}" in
  plan) cmd_plan ;;
  install) cmd_install ;;
  *)
    echo "usage: $0 plan|install" >&2
    exit 2
    ;;
esac
