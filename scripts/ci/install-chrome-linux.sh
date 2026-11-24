#!/usr/bin/env bash
# Ensure google-chrome is on PATH for Linux CI runners. macOS-latest
# and windows-latest ship with Chrome preinstalled; ubuntu-latest
# usually does too, but fall back to the upstream .deb if it ever
# doesn't.
set -euo pipefail

if ! command -v google-chrome >/dev/null 2>&1; then
  echo "google-chrome not on PATH — installing"
  export DEBIAN_FRONTEND=noninteractive
  APT_OPTS='-o Acquire::http::Timeout=15 -o Acquire::Retries=2'
  wget -q --timeout=30 --tries=2 https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get $APT_OPTS install -y ./google-chrome-stable_current_amd64.deb
fi
google-chrome --version
