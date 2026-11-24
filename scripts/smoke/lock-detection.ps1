# Smoke the SingletonLock detection path on Windows: boot Chrome against
# its real user-data-dir (which on Windows creates an empty `lockfile`
# marker), then invoke `browserless profile launch` and assert it
# refuses with exit 3 + "already running" message.
#
# Windows-specific quirks this covers:
#   - The Chromium "lockfile" is a regular empty file, not a symlink
#     with a host-N-pid target like POSIX SingletonLock. The
#     src/browsers/lock.ts:checkProfileLock branch for win32 must read
#     the file's mere presence (no PID parsing).
#   - Without lock.pid, the error message must NOT contain "(PID …)"
#     — formatProfileBusyMessage's `pid` ?? branch.

$ErrorActionPreference = 'Stop'

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
    $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
}

# Boot Chrome against its real user-data-dir (creates the lockfile).
$bg = Start-Process -FilePath $chrome -ArgumentList "--headless=new","--disable-gpu","about:blank" -PassThru -NoNewWindow
Start-Sleep -Seconds 5

# Now `profile launch` should refuse with exit 3.
$err = "$env:RUNNER_TEMP\lock-err.txt"
$proc = Start-Process -FilePath "browserless" `
    -ArgumentList "profile","launch","--browser","chrome","--profile","Default","--headless","--json" `
    -PassThru -NoNewWindow -Wait -RedirectStandardError $err

Write-Host "Exit code: $($proc.ExitCode)"
if (Test-Path $err) {
    Write-Host "stderr:"
    Get-Content $err | Write-Host
}

# Cleanup the bg Chrome before assertion so a failure path doesn't leak.
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force

if ($proc.ExitCode -ne 3) {
    Write-Error "Expected exit 3 (PreconditionError), got $($proc.ExitCode)"
    exit 1
}

$stderrContent = if (Test-Path $err) { Get-Content $err -Raw } else { "" }
if ($stderrContent -notmatch "already running") {
    Write-Error "Lock-detect message did not include 'already running'"
    exit 1
}

Write-Host "✓ Lock detection on Windows correctly refuses with exit 3"
