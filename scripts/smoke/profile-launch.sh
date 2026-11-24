#!/usr/bin/env bash
#
# Smoke `browserless profile launch --headless --json` end-to-end on
# Linux + macOS. The CLI prints a single JSON object once the launched
# browser's CDP endpoint is up, then blocks. We wait for that JSON,
# verify it contains `webSocketDebuggerUrl` + `pid`, then SIGINT the CLI
# and assert no orphan Chrome processes remain.
#
# What this covers that unit tests can't:
#   - npm bin shim resolves the global `browserless` command on PATH
#   - real Chrome boots headless + binds a CDP port
#   - SIGTERM → SIGKILL grace path + the unref/destroy stdio cleanup in
#     src/capture/launch.ts:killBrowser actually reaps the process tree
#   - No `taskkill` here — that's the Windows path; POSIX uses signals
set -euo pipefail

# Per-OS process-match pattern for `pgrep` so we can verify cleanup
# afterwards. On Linux Chrome's argv[0] is `google-chrome`; on macOS the
# real binary path is what argv[0] reports.
case "${RUNNER_OS:-$(uname -s)}" in
  Linux|linux)
    CHROME_PGREP_PATTERN="google-chrome"
    CHROME_PKILL_PATTERN="google-chrome"
    ;;
  macOS|Darwin|macos)
    CHROME_PGREP_PATTERN="Google Chrome.app/Contents/MacOS/Google Chrome"
    CHROME_PKILL_PATTERN="Google Chrome.app/Contents/MacOS/Google Chrome"
    ;;
  *)
    echo "Unsupported RUNNER_OS: ${RUNNER_OS:-$(uname -s)}"
    exit 1
    ;;
esac

launch_out=$(mktemp)
launch_err=$(mktemp)

browserless profile launch --browser chrome --profile Default --headless --json \
  > "$launch_out" 2> "$launch_err" &
cli_pid=$!

# Poll up to 60 s for the JSON readiness signal — the CLI prints it once
# the CDP endpoint is reachable, then sleeps until killed.
for _ in $(seq 1 30); do
  sleep 2
  if [ -s "$launch_out" ]; then
    break
  fi
done

if [ ! -s "$launch_out" ]; then
  echo "=== launch stdout ==="
  cat "$launch_out" || true
  echo "=== launch stderr ==="
  cat "$launch_err" || true
  kill "$cli_pid" 2>/dev/null || true
  pkill -KILL -f "$CHROME_PKILL_PATTERN" 2>/dev/null || true
  echo "profile launch produced no JSON within 60s"
  exit 1
fi

echo "=== launch stdout ==="
cat "$launch_out"

if ! grep -q "webSocketDebuggerUrl" "$launch_out"; then
  echo "JSON output missing webSocketDebuggerUrl"
  kill "$cli_pid" 2>/dev/null || true
  pkill -KILL -f "$CHROME_PKILL_PATTERN" 2>/dev/null || true
  exit 1
fi
if ! grep -qE '"pid":\s*[0-9]+' "$launch_out"; then
  echo "JSON output missing pid"
  kill "$cli_pid" 2>/dev/null || true
  pkill -KILL -f "$CHROME_PKILL_PATTERN" 2>/dev/null || true
  exit 1
fi
echo "✓ JSON output has webSocketDebuggerUrl + pid"

# Cleanup: SIGINT the CLI (exercises the signal handler + 2 s grace
# before SIGKILL). 4 s sleep is the published grace + slop for the
# kernel to reap.
kill -INT "$cli_pid" 2>/dev/null || true
sleep 4

if pgrep -f "$CHROME_PGREP_PATTERN.*--remote-debugging-port" >/dev/null 2>&1; then
  echo "⚠ Orphan Chrome processes after CLI SIGINT — cleanup may be broken"
  pgrep -lf "$CHROME_PGREP_PATTERN.*--remote-debugging-port"
  pkill -KILL -f "$CHROME_PKILL_PATTERN" 2>/dev/null || true
  exit 1
fi
echo "✓ No orphan Chrome processes — SIGTERM grace + cleanup works"
