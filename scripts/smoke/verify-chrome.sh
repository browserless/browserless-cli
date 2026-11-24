#!/usr/bin/env bash
#
# Verify Google Chrome is installed and resolvable at the OS-standard
# path. Falls back to installing if not present:
#   - Linux: `apt-get install ./google-chrome-stable_current_amd64.deb`
#   - macOS: `brew install --cask google-chrome`
#
# CI runner images (ubuntu-latest, macos-latest) usually ship Chrome, but
# image upgrades have removed it before — having the fallback keeps smoke
# tests robust to that drift.
set -euo pipefail

case "${RUNNER_OS:-$(uname -s)}" in
  Linux|linux)
    if ! command -v google-chrome >/dev/null 2>&1; then
      echo "google-chrome not on PATH — installing from Google's stable channel"
      wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
      sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
      rm -f google-chrome-stable_current_amd64.deb
    fi
    which google-chrome
    google-chrome --version
    echo "✓ Chrome available"
    ;;
  macOS|Darwin|macos)
    chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if [ ! -x "$chrome" ]; then
      echo "Chrome not found at $chrome — installing via brew"
      brew install --cask google-chrome
    fi
    "$chrome" --version
    echo "✓ Chrome available at $chrome"
    ;;
  *)
    echo "Unsupported RUNNER_OS for this script: ${RUNNER_OS:-$(uname -s)}"
    exit 1
    ;;
esac
