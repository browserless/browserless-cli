#!/usr/bin/env bash
#
# Round-trip the local-only CLI commands (config + profile exclude) and
# assert they reflect their writes. Runs on Linux + macOS via the same
# bash. Called by smoke-{linux,macos}.yml after the CLI is linked to PATH.
#
# Asserts:
#   - `config set server X` is readable back via `config get server`
#   - `profile exclude add example.com` then `rm example.com` actually removes it
#
# Exits non-zero on any mismatch. Output is GitHub-Actions-friendly (no colors).
set -euo pipefail

browserless config get server
browserless config set server http://localhost:3000

stored=$(browserless config get server)
if [ "$stored" != "http://localhost:3000" ]; then
  echo "config set/get round-trip failed: got '$stored', expected 'http://localhost:3000'"
  exit 1
fi

browserless profile exclude add example.com
browserless profile exclude add "*.test.com"
browserless profile exclude list

browserless profile exclude rm example.com
if browserless profile exclude list | grep -q "example.com"; then
  echo "profile exclude rm did not remove example.com — list still contains it"
  exit 1
fi

echo "✓ Local-only commands round-trip cleanly"
