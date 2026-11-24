#!/usr/bin/env bash
#
# Smoke the SingletonLock detection path: boot Chrome against its real
# user-data-dir (creates SingletonLock symlink), then invoke
# `browserless profile launch` and assert it refuses with exit 3 +
# "already running" message. Linux + macOS.
#
# What this covers that unit tests can't:
#   - SingletonLock is a real symlink (vs Windows empty marker)
#   - The lock-check correctly reads the symlink target's PID
#   - The PreconditionError surfaces with the canonical message
set -euo pipefail

case "${RUNNER_OS:-$(uname -s)}" in
  Linux|linux)
    chrome=$(command -v google-chrome)
    CHROME_PKILL_PATTERN="google-chrome"
    CHROME_LAUNCH_ARGS=(--headless=new --disable-gpu --no-sandbox about:blank)
    ;;
  macOS|Darwin|macos)
    chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    CHROME_PKILL_PATTERN="Google Chrome.app/Contents/MacOS/Google Chrome"
    CHROME_LAUNCH_ARGS=(--headless=new --disable-gpu about:blank)
    ;;
  *)
    echo "Unsupported RUNNER_OS: ${RUNNER_OS:-$(uname -s)}"
    exit 1
    ;;
esac

"$chrome" "${CHROME_LAUNCH_ARGS[@]}" &
bg_pid=$!
# 5 s gives Chrome time to acquire the SingletonLock and write its PID.
sleep 5

# The CLI must refuse — capture stderr separately so we can assert on it
# afterwards. `set +e` because we explicitly want to inspect the exit
# code below; without it the next line would terminate the script.
launch_err=$(mktemp)
set +e
browserless profile launch --browser chrome --profile Default --headless --json 2> "$launch_err"
exit_code=$?
set -e

echo "exit code: $exit_code"
echo "stderr:"
cat "$launch_err"

# Cleanup the bg Chrome before any assertion so a failure path doesn't
# leak processes.
kill "$bg_pid" 2>/dev/null || true
pkill -KILL -f "$CHROME_PKILL_PATTERN" 2>/dev/null || true

if [ "$exit_code" != "3" ]; then
  echo "Expected exit 3 (PreconditionError), got $exit_code"
  exit 1
fi
if ! grep -q "already running" "$launch_err"; then
  echo "stderr missing 'already running' message"
  exit 1
fi

echo "✓ Lock detection correctly refuses with exit 3"
