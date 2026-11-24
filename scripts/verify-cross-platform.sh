#!/usr/bin/env bash
#
# CI smoke-test helper: runs `profile sources list` and checks that the
# command exits cleanly on whichever OS / Node combination the CI matrix
# is currently running. Catches obvious regressions in the path/registry
# layer (wrong env var name on Windows, missing binary candidate, ...)
# without needing a real browser to be installed.
#
# Run from the repo root:
#   ./scripts/verify-cross-platform.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "→ Installing dependencies"
  npm ci --silent
fi

if [ ! -d build ]; then
  echo "→ Building"
  npm run build --silent
fi

echo "→ Running \`browserless profile sources list\`"
# `--help` would also work, but `sources list` exercises the discovery
# pass on the current OS — that's the cross-platform-relevant code path.
node build/cli.js profile sources list >/tmp/browserless-sources.out 2>&1 \
  || { echo "✗ Command failed"; cat /tmp/browserless-sources.out; exit 1; }

echo "→ Output:"
sed 's/^/    /' /tmp/browserless-sources.out

echo "→ Running CLI smoke checks"
node build/cli.js --version >/dev/null
node build/cli.js --help >/dev/null
node build/cli.js profile --help >/dev/null
node build/cli.js auth --help >/dev/null
node build/cli.js config --help >/dev/null

echo "✓ Cross-platform smoke checks passed"
