#!/usr/bin/env bash
# Install Chromium via Snap and verify the binary + user-data-dir
# parent are where the registry expects them. This is the second
# Linux install style our discover.ts cares about (alongside apt's
# `~/.config/chromium`): Snap confines Chromium to `~/snap/chromium/...`,
# so the registry has to know about both locations.
set -euo pipefail

# Snap is preinstalled on ubuntu-latest runners; refresh & install.
# api.snapcraft.io has multi-hour 503 outages and slow-rolls where each
# attempt hangs for minutes. Bound each attempt with `timeout` so the
# retry loop can finish well under the step's 5-min wall, then SOFT-FAIL
# so a snap-store hiccup doesn't block PRs. The downstream discovery
# smoke already self-skips when no chromium binary is present
# (lookup-only mode), so the only thing we lose is coverage of the
# Snap install path for that one run.
ATTEMPT_TIMEOUT_S=60
SNAP_INSTALLED=0
for attempt in 1 2 3; do
  if sudo timeout "${ATTEMPT_TIMEOUT_S}s" snap install chromium; then
    SNAP_INSTALLED=1
    break
  fi
  if [ "$attempt" -lt 3 ]; then
    echo "snap install attempt $attempt failed; retrying in 5s..." >&2
    sleep 5
  fi
done

if [ "$SNAP_INSTALLED" -ne 1 ]; then
  echo "::warning::snap install chromium failed after 3 attempts — skipping snap-chromium coverage for this run. Discovery smoke will lookup-only-skip chromium." >&2
  exit 0
fi

# Sanity: the binary MUST resolve on PATH at the snap-shim location — this
# is exactly what the lookup-only discovery smoke keys off (it asserts the
# registry finds /snap/bin/chromium via `profile sources list`; it never
# launches the binary, because snap confinement blocks the capture
# pipeline's tmp user-data-dir copy). If snap claimed success but produced
# no binary, fail loudly — that is a real regression, not a flake.
which chromium

# `chromium --version` is an informational probe, NOT a gate. Recent snap
# revisions ship a launcher wrapper that exits 3 ("Content snap GPU wrapper
# '/snap/chromium/<rev>/gpu-2404/...' not found: ensure slot is connected")
# on headless CI runners with no connected gpu-2404 content provider. The
# binary is present and lookup-only discovery never launches it, so this
# exit code must not sink the Linux leg. Logging the version on healthy
# runners is still worth keeping — it's how we'd spot the next snap-revision
# regression (e.g. this one) in the CI log.
chromium --version || \
  echo "::warning::'chromium --version' exited non-zero (snap GPU wrapper; no gpu-2404 provider on this runner) — binary present on PATH, which is all the lookup-only discovery smoke needs. Continuing." >&2

# Ensure the snap data dir scaffolding exists so the smoke can seed
# Default/Preferences without snap-confinement surprises.
mkdir -p "$HOME/snap/chromium/common/chromium/Default"
