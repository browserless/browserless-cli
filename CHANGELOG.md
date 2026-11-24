# Changelog

## 0.7.0 (2026-11-20)


### Features

* use saved cloud profiles for agent sign-in with `agent --cloud-profile <name>`; the agent no longer asks for a username and password

## 0.6.1 (2026-11-13)


### Bug Fixes

* bound decoded API responses and body deadlines
* capture over a private pipe instead of a local debugging port, and stop the headless browser and delete the temporary profile copy when a capture is interrupted
* escape remote agent terminal output
* escape terminal controls in error and profile displays
* pin custom browser registration paths

## 0.6.0 (2026-11-05)


### Features

* record failure category, code and HTTP status in CLI telemetry

## 0.5.2 (2026-10-30)


### Bug Fixes

* reject authenticated API redirects
* isolate capture smoke state and replay

## 0.5.1 (2026-10-22)


### Bug Fixes

* detect the Windows cookie-file lock during profile capture

## 0.5.0 (2026-10-16)


### Features

* add profile terms command

## 0.4.2 (2026-10-13)


### Bug Fixes

* enforce secure server URLs before sending tokens

## 0.4.1 (2026-10-06)


### Bug Fixes

* restrict telemetry to trusted API hosts

## 0.4.0 (2026-09-22)


### Features

* track CLI profile setup attempts

## 0.3.0 (2026-08-04)


### Features

* Profile refresh replays the capture settings a profile was created with — no flags needed

## 0.2.0 (2026-06-18)


### Features

* add usage telemetry

## 0.1.0 (2026-06-05)


### Features

* Interactive agent chat via `browserless agent`

## 0.0.3 (2026-06-05)


### Bug Fixes

* **capture:** connect to the browser CDP endpoint, not a default page target
* **capture:** retry the default-target CDP connect on "No inspectable targets"
* **capture:** wait for an inspectable target before connecting (fixes "No inspectable targets")
* **cli:** set process.exitCode instead of process.exit() on error path
* **cli:** windows/macos flaky tests

## 0.0.2 (2026-05-27)


### Features

* --region sfo|lon|ams shortcut + region config key
* Add the Browserless CLI for authenticated profile management
* **capture:** live progress events, skip vendor NTP origins, cap loop on attempts, + --auto-fit/--keep-domain/--only-domain for artifact size mgmt
* **capture:** skip sensitive profile files from temp copy + CI smoke that catches future Chrome additions
* **ci:** cli-smoke integration test invokes every command on every OS via stub server
* **disclaimer:** include privacy-policy link in liability disclaimer text
* **registry:** discover Snap-installed Chromium on Linux + CI matrix axis for it
* **scripts:** add npm run dev (build + npm link) for one-shot local-dev setup
* **sources:** surface broken custom-browser registrations in sources list


### Bug Fixes

* address review findings — surface silent fallbacks, narrow types, add coverage (+57 tests)
* **api:** preserve path prefix on configured server URL (self-hosted-behind-/browserless/)
* **browsers:** swallow fs.readdir EACCES/EIO so one bad source doesn't abort discovery
* **browsers:** try every candidate user-data-dir so Snap chromium isn't masked by a stale ~/.config/chromium
* **capture:** apply --only-domain pre-navigation so the per-run origin cap isn't burned on non-matching origins
* **capture:** fail fast on all-invalid --only-domain so pre/post filters can't silently diverge
* **capture:** fail-fast on consecutive transport-dead CDP errors + throw on all-origins-failed
* **capture:** filter Windows process sweep to chrome family binary — was killing PowerShell itself
* **capture:** per-origin 15 s timeout so a single hung CDP tab can't lock the whole capture
* **capture:** richer CDP-timeout diagnostics (pid/exit/args) + spec slop for CI
* **capture:** run Windows process sweep detached + fire-and-forget — synchronous PowerShell call was crashing the CLI
* **capture:** spawnSync taskkill on Windows + poll for orphan reap in test (Chrome tree teardown is slower on Windows)
* **capture:** surface browser stderr in CDP-timeout error for diagnostics
* **capture:** sweep Chrome processes by user-data-dir on Windows — renderers/utilities use CREATE_BREAKAWAY_FROM_JOB and survive taskkill /T
* **capture:** tally origin drops from both pre-nav skip and post-capture filter so a future post-capture filter can't silently undercount
* **capture:** unref child + close stdio after kill — unblock Node exit when browser doesn't reap fast; bypass .cmd shim on Windows when detached so CTRL_BREAK_EVENT targets the CLI
* **ci:** apt options go after apt-get, not after sudo
* **ci:** avoid $HOME override in capture smoke — add BROWSERLESS_CONFIG_DIR + custom browser source
* **ci:** BROWSERLESS_DISABLE_KEYCHAIN escape hatch + drop whitespace-arg test (Windows cmd trims it)
* **ci:** drop flaky windows-kill dep; use inline PowerShell P/Invoke for CTRL_BREAK_EVENT
* **ci:** make CDP-wait timeout configurable; bump to 60s in capture smoke (macOS cold-boot)
* **ci:** restore apt-get update before gnome-keyring install — cached lists go stale
* **ci:** same Chrome seed fix for linux smoke
* **ci:** seed Chrome user-data-dir directly instead of racing first-run boot
* **ci:** spawn browserless.cmd directly on Windows — shell:true splits args with spaces
* **ci:** split discovery smoke — chromium uses lookup-only mode (registry hit only); inspect mode kept for brave/edge (full capture)
* **ci:** Windows arg quoting — shell:true with manual cmd-metachar quoting
* **commands:** add missing region?: string to upload/refresh Options interfaces
* **discover:** don't apply which-fallback to user-data-dir lookup — would return a binary path as a directory and crash readdir
* **exclusion:** punycode-normalize bare hostnames so Unicode patterns match IDN cookie domains
* **lock:** check 'lockfile' on Windows, 'SingletonLock' on POSIX (Chrome uses different filenames)
* **lock:** Windows lockfile is an empty marker — presence = locked (no PID)
* **registry:** discover Brave at per-user install path on Windows (%LOCALAPPDATA%) — default for choco / non-admin installs
* **sh:** drop duplicate Linux pattern in verify-chrome.sh case
* **sources:** validate --path and --user-data-dir at sources add time
* **test:** bound chrome.exe warmup to 30s so it can't hang CI
* **test:** poll lstatSync for SingletonLock + skip Windows orphan-check (documented limitation)
* **test:** skip SIGTERM-trap killBrowser test on Windows (no real signals)
* **trim-state:** don't treat unparseable origins as protected by --keep-domain


### Reverts

* drop Windows orphan-cleanup hacks — Chrome utility processes self-exit within ~30s; not worth the test/CLI complexity for an external-force-kill-only scenario

## Changelog

All notable changes to `@browserless.io/cli` will be documented in this file.
