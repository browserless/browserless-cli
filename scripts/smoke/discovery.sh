#!/usr/bin/env bash
#
# Smoke `browserless profile sources list` in both text + JSON modes,
# asserting Chrome is detected at the OS-canonical path. JSON parsing is
# done via a small node -e snippet because jq isn't installed on every
# runner and node is already there.
#
# Linux: any binary path is accepted (whichOnPath fallback may return
# `/opt/google/chrome/google-chrome` instead of `/usr/bin/google-chrome`).
# macOS: must contain "Google Chrome.app" (verifies macOS path branch).
set -euo pipefail

browserless profile sources list

json=$(browserless profile sources list --json)
binary=$(printf '%s' "$json" | node -e "
  const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const c = data.find(b => b.browserKey === 'chrome');
  if (!c) { console.error('chrome not detected'); process.exit(1); }
  console.log(c.binaryPath);
")

echo "Detected Chrome at: $binary"

case "${RUNNER_OS:-$(uname -s)}" in
  Linux|linux)
    # Could be /usr/bin/google-chrome (registry hardcoded) or
    # /opt/google/chrome/google-chrome (whichOnPath fallback). Either is
    # fine — this verifies the registry path OR the fallback works.
    if [ -z "$binary" ]; then
      echo "empty binary path"
      exit 1
    fi
    echo "✓ Discovery found Chrome at $binary"
    ;;
  macOS|Darwin|macos)
    if [[ "$binary" != *"Google Chrome.app"* ]]; then
      echo "unexpected binary path on macOS: $binary"
      exit 1
    fi
    echo "✓ Discovery found Chrome with macOS path"
    ;;
  *)
    echo "Unsupported RUNNER_OS for this script: ${RUNNER_OS:-$(uname -s)}"
    exit 1
    ;;
esac
