#!/usr/bin/env bash
# Wrap the keychain smoke in a D-Bus session with gnome-keyring
# unlocked. Without this, keytar.setPassword on Linux blocks waiting
# for org.freedesktop.secrets (which doesn't exist on the runner).
#
# The password 'ci-runner' is throwaway — anything works, since
# nothing else accesses the keyring on this VM.
set -euo pipefail

dbus-run-session -- bash -c '
  echo -n "ci-runner" | gnome-keyring-daemon --unlock
  npm run test:keychain
'
