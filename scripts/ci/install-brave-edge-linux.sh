#!/usr/bin/env bash
# Discovery smoke exercises the built-in registry path for Brave and
# Edge. ubuntu-latest doesn't preinstall either; we add their apt
# repositories here and install. Edge has an official Microsoft repo;
# Brave has one hosted on S3.
set -euo pipefail

# See install-gnome-keyring-linux.sh for the rationale on these flags —
# `DEBIAN_FRONTEND=noninteractive` + http timeout + bounded retries keep
# a stuck mirror from burning an hour of CI time.
export DEBIAN_FRONTEND=noninteractive
APT_OPTS='-o Acquire::http::Timeout=15 -o Acquire::Retries=2'

sudo apt-get $APT_OPTS install -y curl gnupg

# Brave
sudo curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
  https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" \
  | sudo tee /etc/apt/sources.list.d/brave-browser-release.list

# Edge
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
  | sudo gpg --dearmor -o /usr/share/keyrings/microsoft-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] https://packages.microsoft.com/repos/edge stable main" \
  | sudo tee /etc/apt/sources.list.d/microsoft-edge.list

sudo apt-get $APT_OPTS update -qq
sudo apt-get $APT_OPTS install -y brave-browser microsoft-edge-stable
brave-browser --version
microsoft-edge --version

# Ubuntu 24.04 runners restrict unprivileged user namespaces via AppArmor
# (kernel.apparmor_restrict_unprivileged_userns=1), so Chromium can't use the
# namespace sandbox and falls back to the setuid sandbox. That helper aborts
# (setuid_sandbox_host.cc: "not configured correctly … owned by root and has
# mode 4755") unless it is setuid-root. Edge's helper on the runner isn't
# (Brave's is, which is why only Edge capture failed). Restore the bit so the
# headless launch the discovery smoke performs can start.
EDGE_SANDBOX=/opt/microsoft/msedge/msedge-sandbox
if [ -f "$EDGE_SANDBOX" ]; then
  sudo chown root:root "$EDGE_SANDBOX"
  sudo chmod 4755 "$EDGE_SANDBOX"
fi
