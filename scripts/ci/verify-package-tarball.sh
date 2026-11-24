#!/usr/bin/env bash
#
# Verify the npm tarball that would ship from a `npm publish` against an
# allowlist. Catches accidental edits to `package.json:files`, a broken
# `prepack`, or stray internal docs / sourcemaps creeping back in.
#
# Runs `npm pack` (which triggers `prepack`, which rebuilds with
# `tsconfig.publish.json` and strips test artifacts) and then greps the
# resulting tar listing for known-bad patterns:
#   - `.spec.` — compiled test specs
#   - `/src/` — unbuilt TypeScript sources
#   - `/test-helpers/` — mock-keychain, stub-server, temp-home
#   - `AGENTS.md` / `CLAUDE.md` / `test-cli.md` — contributor docs
#   - `.map` — sourcemaps (we explicitly disable them for publish, this
#     guards against the tsconfig drifting back)
#
# Exits non-zero on any match so CI fails loudly.
set -euo pipefail

# `npm pack` writes the filename it produced to its last stdout line.
# Capture that directly rather than scanning /tmp — `ls -t /tmp/*.tgz`
# would pick up unrelated tarballs left there by other processes.
pack_name=$(npm pack --pack-destination=/tmp | tail -n1)
tarball="/tmp/${pack_name}"

listing=$(tar -tzf "$tarball")
echo "$listing"

forbidden=$(echo "$listing" | grep -E '(\.spec\.|/src/|/test-helpers/|^package/(AGENTS|CLAUDE)\.md$|^package/test-cli\.md$|\.map$)' || true)
if [ -n "$forbidden" ]; then
  echo "::error::Forbidden files in npm tarball:"
  echo "$forbidden"
  exit 1
fi

echo "✓ Tarball contents pass the allowlist"
