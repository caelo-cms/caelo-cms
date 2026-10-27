#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Add files to the `e2e-livedit-ledger` branch (weekly spend in runs/, the
# release gate's per-scenario greens in greens/) and push, pruning both
# directories in the same commit.
#
#   bash apps/admin/e2e-livedit/lib/ledger-commit.sh <message> <src-dir>
#
# Every file under <src-dir> lands at the same relative path on the branch
# (e.g. <src-dir>/runs/x.json -> runs/x.json). Parallel runs push to the same
# branch, so each attempt rebuilds its commit on the newest tip. Needs
# GH_TOKEN (contents: write), REPO (owner/name) and RUNNER_TEMP in the env;
# LEDGER_REMOTE replaces the GitHub remote (ledger-commit.test.ts).
# Exits 1 when the push did not land after 5 attempts; the caller decides
# whether that is a warning.
set -uo pipefail

message="$1"
src="$(cd "$2" && pwd)"
lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
branch=e2e-livedit-ledger
dir="$RUNNER_TEMP/ledger-wt-$$"

rm -rf "$dir" && mkdir -p "$dir" && cd "$dir" || exit 1
git init -q
git remote add origin "${LEDGER_REMOTE:-https://x-access-token:${GH_TOKEN:-}@github.com/${REPO:-}.git}"
git config user.email "github-actions[bot]@users.noreply.github.com"
git config user.name "github-actions[bot]"
for attempt in 1 2 3 4 5; do
  if git fetch -q --depth 1 origin "$branch" 2>/dev/null; then
    git checkout -q -f -B "$branch" FETCH_HEAD
  else
    git checkout -q -f --orphan "$branch"
    git rm -rfq . 2>/dev/null || true
  fi
  cp -R "$src/." .
  mkdir -p runs greens
  ls runs > "$RUNNER_TEMP/ledger-runs.txt"
  for stale in $(bun run "$lib/budget.ts" stale --names "$RUNNER_TEMP/ledger-runs.txt"); do
    git rm -q --cached "runs/$stale" 2>/dev/null; rm -f "runs/$stale"
  done
  ls greens > "$RUNNER_TEMP/ledger-greens.txt"
  for stale in $(bun run "$lib/main-greens.ts" stale --names "$RUNNER_TEMP/ledger-greens.txt"); do
    git rm -q --cached "greens/$stale" 2>/dev/null; rm -f "greens/$stale"
  done
  git add -A runs greens
  git commit -qm "$message" || true
  if git push -q origin "HEAD:refs/heads/$branch"; then exit 0; fi
  sleep $((attempt * 3))
done
exit 1
