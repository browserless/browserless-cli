#!/usr/bin/env bash
# keytar on Linux talks to org.freedesktop.secrets over D-Bus.
# ubuntu-latest doesn't start a secret service by default, so we
# install gnome-keyring here. The keychain smoke script wraps the
# actual mocha run inside `dbus-run-session` (provided by the `dbus`
# package, which is preinstalled) and unlocks the keyring at that time.
#
# Two non-obvious choices below:
#   1. `apt-get update` is REQUIRED — runner's cached package lists
#      can point at gtk4 versions that have since been rotated out of
#      the security mirror, producing 404s. (gtk4 is an unavoidable
#      hard dep of gnome-keyring's pinentry / gcr4 chain.)
#   2. `--no-install-recommends` skips the optional GUI dep chain
#      `gnome-keyring`'s metadata otherwise drags in. Without it this
#      step takes ~10 min; with it, ~2 min.
#
# We also don't install libsecret-1-dev (keytar build dep, already
# handled by npm ci) or dbus-x11 (X-aware D-Bus; we're headless and
# `dbus-run-session` is in plain `dbus`).
set -euo pipefail

# `DEBIAN_FRONTEND=noninteractive` is critical — without it some
# gnome-keyring deps can spin forever waiting on a debconf prompt that
# never gets answered on a headless runner.
# `Acquire::http::Timeout=15` + `Acquire::Retries=2` bound mirror hangs
# so a single dead Azure mirror can't hold the build for an hour.
export DEBIAN_FRONTEND=noninteractive
APT_OPTS='-o Acquire::http::Timeout=15 -o Acquire::Retries=2'

sudo apt-get $APT_OPTS update -qq
sudo apt-get $APT_OPTS install -y --no-install-recommends gnome-keyring
