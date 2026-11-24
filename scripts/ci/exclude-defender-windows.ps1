# Capture-smoke flake mitigation (Windows only).
#
# The capture pipeline copies a multi-MB Chrome user-data-dir into %TEMP%,
# then a headless chrome.exe reads it back one origin at a time. On hosted
# Windows runners Defender real-time scanning hits every written/read file
# and the chrome.exe image on launch, intermittently pushing a single
# per-origin capture past its deadline (the cli-capture-smoke
# "timed out after 15000ms" flake). Excluding the temp tree Node's
# os.tmpdir() resolves to (%TEMP%) plus the chrome.exe process removes that
# source of nondeterministic latency.
#
# Best-effort by design: Add-MpPreference can fail when Defender is managed
# or absent on a runner image. A failure here must NOT fail the job — that
# would turn an occasional flake into a hard failure on every Windows run.
# So we swallow errors and exit 0; if the capture flake recurs in CI, that
# is the signal the exclusion didn't take effect on this runner image.
$ErrorActionPreference = 'Continue'

$targets = @(
  @{ Kind = 'path';    Value = $env:TEMP },
  @{ Kind = 'process'; Value = 'chrome.exe' }
)

foreach ($t in $targets) {
  try {
    if ($t.Kind -eq 'path') {
      Add-MpPreference -ExclusionPath $t.Value -ErrorAction Stop
    } else {
      Add-MpPreference -ExclusionProcess $t.Value -ErrorAction Stop
    }
    Write-Host "Defender exclusion added ($($t.Kind)): $($t.Value)"
  } catch {
    Write-Host "Defender exclusion skipped ($($t.Kind) $($t.Value)): $($_.Exception.Message)"
  }
}

exit 0
