#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Create or update THE e2e-livedit comment on a PR (one per PR, edited in
# place instead of a new comment per run).
#
#   bash apps/admin/e2e-livedit/lib/sticky-comment.sh <pr-number> <body-file>
#
# The comment is found by the marker below, which this script puts on the
# first line of the body, among the comments of the workflow's own bot user.
# Needs GH_TOKEN (pull-requests: write) and REPO (owner/name) in the env.
set -euo pipefail

pr="$1"
body_file="$2"
marker="<!-- e2e-livedit-sticky -->"

if ! head -1 "$body_file" | grep -qF "$marker"; then
  { echo "$marker"; cat "$body_file"; } > "$body_file.sticky"
  body_file="$body_file.sticky"
fi

existing=$(gh api "repos/$REPO/issues/$pr/comments" --paginate \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" \
  | tail -1)

if [ -n "$existing" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$existing" -F "body=@$body_file" > /dev/null
else
  gh api -X POST "repos/$REPO/issues/$pr/comments" -F "body=@$body_file" > /dev/null
fi
