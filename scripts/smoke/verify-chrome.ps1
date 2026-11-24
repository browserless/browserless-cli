# Verify Chrome is installed on the Windows runner. Both Program Files
# locations exist on the image (32-bit + 64-bit); we accept either.
# Unlike Linux/macOS, we don't install a fallback — if Chrome isn't on
# windows-latest, the runner image has drifted and CI should fail loudly
# rather than silently install a different version.

$ErrorActionPreference = 'Stop'

$chromeCandidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
    Write-Error "Chrome not found in any expected location. Runner image may have changed."
    exit 1
}

Write-Host "Chrome at: $chrome"
& $chrome --version
Write-Host "✓ Chrome available"
