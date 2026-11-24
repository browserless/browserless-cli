# Smoke `browserless profile sources list` in both text + JSON modes,
# asserting Chrome is detected with a Program Files binary path.
#
# Verifies path-with-spaces handling in spawn() — Chrome lives at
# `C:\Program Files\Google\Chrome\Application\chrome.exe` and an early
# bug in our shell-quoting on Windows split that into `C:\Program` +
# `Files\...`. Pinning the "must contain 'Program Files'" check guards
# against regression.

$ErrorActionPreference = 'Stop'

browserless profile sources list | Out-Host

$json = browserless profile sources list --json | Out-String
$sources = $json | ConvertFrom-Json

if ($null -eq $sources -or $sources.Count -eq 0) {
    Write-Error "No browsers detected"
    exit 1
}

$chromeEntry = $sources | Where-Object { $_.browserKey -eq "chrome" } | Select-Object -First 1
if (-not $chromeEntry) {
    Write-Error "Chrome not in detected browsers"
    $sources | ConvertTo-Json -Depth 5 | Write-Host
    exit 1
}

Write-Host "✓ Discovery found Chrome at $($chromeEntry.binaryPath)"

if ($chromeEntry.binaryPath -notmatch "Program Files") {
    Write-Error "Unexpected Chrome binary path (path-with-spaces handling may be broken): $($chromeEntry.binaryPath)"
    exit 1
}
