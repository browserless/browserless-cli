#!/usr/bin/env bash
#
# Fail when a tracked file carries a reference that doesn't belong in this
# repository's source: issue-tracker IDs (`ABC-123`), source paths of other
# codebases (`server/src/...`), or an injected policy block
# (`<!-- name:policy:start -->`). Comments and docs describe behaviour; why a
# change happened belongs in the commit message.
#
# CHANGELOG.md is skipped: release-please writes it from PR titles, which
# .github/workflows/pr-title.yml checks.
set -euo pipefail

EXCLUDES=(
  ':!CHANGELOG.md'
  ':!package-lock.json'
  ':!scripts/ci/check-internal-references.sh'
)

# `git grep` exits 0 on a match, 1 on none and above 1 on an error. Fail closed
# on errors so an unreadable file can never pass as "no match".
search() {
  local out rc=0
  out=$(git grep -nI "$@" -- . "${EXCLUDES[@]}") || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "::error::git grep failed (exit $rc) while scanning for internal references" >&2
    exit 2
  fi
  printf '%s' "$out"
}

# Tracker-style IDs, minus public identifier schemes (CVE-2024-27980, UTF-8…).
# `-o` prints `file:line:match` once per match, so a public ID can't hide a
# tracker ID on the same line. No word boundaries, so `AUTO-669_x` or
# `xAUTO-669` still match.
id_matches=$(search -oE '[A-Z]{2,}-[0-9]+')
ids=$(printf '%s\n' "$id_matches" |
  grep -vE ':(CVE|GHSA|RFC|ISO|UTF|SHA|ECMA|ES)-[0-9]+$' || true)
paths=$(search -E '(^|[^A-Za-z0-9_])(enterprise|server|account)/src/')
policy=$(search -E '<!-- *[A-Za-z0-9_-]+:policy:(start|end) *-->')

found=0
report() {
  if [ -n "$2" ]; then
    echo "::error::$1"
    echo "$2"
    found=1
  fi
}
report "Issue-tracker IDs in tracked files:" "$ids"
report "Source paths of other codebases in tracked files:" "$paths"
report "Injected policy blocks in tracked files:" "$policy"

if [ "$found" -ne 0 ]; then
  exit 1
fi
echo "✓ No internal references found"
