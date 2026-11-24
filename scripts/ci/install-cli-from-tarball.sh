#!/usr/bin/env bash
# Pack the CLI as it would be published to npm, then install it
# globally. Tests the actual-install path real users hit (bin shim, file
# layout from the `"files"` manifest), not the `npm link` symlink
# shortcut — if a critical file is missing from the tarball, the smoke
# tests below will fail.
#
# Sudo is required for npm's global prefix on POSIX runners; Windows
# doesn't need it. Locally: just run this script in a checkout where
# you don't mind a global install.
set -euo pipefail

tarball=$(npm pack --silent | tail -1)
echo "Packed: $tarball"

case "${RUNNER_OS:-$(uname)}" in
  Linux | Darwin | macOS)
    sudo npm i -g "./$tarball"
    ;;
  *)
    npm i -g "./$tarball"
    ;;
esac
