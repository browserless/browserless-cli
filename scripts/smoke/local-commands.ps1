# Round-trip the local-only CLI commands (config + profile exclude) and
# assert they reflect their writes. Windows pwsh variant of
# scripts/smoke/local-commands.sh — keeps the two in lockstep.
#
# Asserts:
#   - `config set server X` is readable back via `config get server`
#   - `profile exclude add example.com` then `rm example.com` actually removes it
#
# Exits non-zero on any mismatch.

$ErrorActionPreference = 'Stop'

browserless config get server
browserless config set server http://localhost:3000

$stored = browserless config get server
if ($stored -ne "http://localhost:3000") {
    Write-Error "config set/get round-trip failed: got '$stored', expected 'http://localhost:3000'"
    exit 1
}

browserless profile exclude add example.com
browserless profile exclude add "*.test.com"
browserless profile exclude list

browserless profile exclude rm example.com
$remaining = browserless profile exclude list | Out-String
if ($remaining -match "example\.com") {
    Write-Error "profile exclude rm did not remove example.com — list still contains it"
    exit 1
}

Write-Host "✓ Local-only commands round-trip cleanly"
