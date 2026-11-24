# Edge is preinstalled on windows-latest. Brave installs via choco;
# --no-progress keeps the log clean (winget spams \|/ progress bars
# and was broken last time we tried it).
#
# Note: choco's brave package does a *per-user* install under
# %LOCALAPPDATA%, NOT Program Files. We check all three locations
# below because future-proofing.
$ErrorActionPreference = 'Stop'

choco install brave --no-progress --yes

$candidates = @(
  "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe",
  "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
  "C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"
)
$bravePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bravePath) {
  Write-Error "Brave install succeeded but no brave.exe found in any expected location"
  exit 1
}
Write-Host "Brave at: $bravePath"
& $bravePath --version
