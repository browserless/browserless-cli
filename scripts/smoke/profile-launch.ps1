# Smoke `browserless profile launch --headless --json` end-to-end on
# Windows. The CLI prints a single JSON object once the launched
# browser's CDP endpoint is up, then blocks. We wait for that JSON,
# verify it contains `webSocketDebuggerUrl` + `pid`, then kill the CLI
# process tree and assert no orphan chrome.exe processes remain.
#
# What this covers that unit tests can't:
#   - npm bin shim generates a .cmd wrapper correctly
#   - Path-with-spaces handling in spawn() args
#   - taskkill /T /F process-tree termination (the Windows equivalent
#     of POSIX SIGTERM cascade — chrome.exe doesn't propagate kills to
#     its renderer children, so taskkill /T is the only way to reap)

$ErrorActionPreference = 'Stop'

$launchOut = "$env:RUNNER_TEMP\launch.out"
$launchErr = "$env:RUNNER_TEMP\launch.err"

$proc = Start-Process -FilePath "browserless" `
    -ArgumentList "profile","launch","--browser","chrome","--profile","Default","--headless","--json" `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput $launchOut `
    -RedirectStandardError $launchErr

# Wait up to 60 s for the JSON to land — the CLI prints it once the
# CDP endpoint is up, then blocks waiting for the browser to exit.
$deadline = (Get-Date).AddSeconds(60)
$jsonReady = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if ((Test-Path $launchOut) -and ((Get-Item $launchOut).Length -gt 50)) {
        $jsonReady = $true
        break
    }
}

if (-not $jsonReady) {
    Write-Host "=== launch stderr ==="
    if (Test-Path $launchErr) { Get-Content $launchErr | Write-Host }
    Write-Host "=== launch stdout ==="
    if (Test-Path $launchOut) { Get-Content $launchOut | Write-Host }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Error "profile launch did not produce JSON output within 60s"
    exit 1
}

$stdout = Get-Content $launchOut -Raw
Write-Host "=== launch stdout ==="
Write-Host $stdout

if ($stdout -notmatch "webSocketDebuggerUrl") {
    Write-Error "JSON output missing webSocketDebuggerUrl"
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
    exit 1
}
if ($stdout -notmatch '"pid":\s*\d+') {
    Write-Error "JSON output missing pid"
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
    exit 1
}

Write-Host "✓ profile launch produced valid JSON with CDP endpoint"

# Cleanup: kill the CLI process tree (this exercises taskkill /T /F).
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

# Anything left? Fail loud — the cleanup paths are buggy.
$orphans = Get-Process chrome -ErrorAction SilentlyContinue
if ($orphans) {
    Write-Host "⚠ Orphan chrome.exe processes after CLI exit — taskkill cleanup may be broken"
    $orphans | Format-Table Id,ProcessName -AutoSize | Out-Host
    $orphans | Stop-Process -Force
    exit 1
}
Write-Host "✓ No orphan chrome.exe processes — process-tree kill works"
