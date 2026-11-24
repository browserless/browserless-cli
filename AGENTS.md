# Browserless CLI

`@browserless.io/cli` — a cross-platform Node.js CLI that captures auth state (cookies, localStorage, IndexedDB) from a user's local Chrome/Brave/Edge/Chromium profile and uploads it to a Browserless server as a reusable cloud profile. Distributed via `npm install -g @browserless.io/cli`; ships first for profile management with reserved namespace for future `session`, `bql`, `token`, `workspace` resources.

This is the guide for contributors and coding agents working in this repository. `CLAUDE.md` imports it, so Claude Code, Codex, Amp and other agents all read the same instructions.

## Architecture Overview

The CLI is organized around **three orthogonal layers** on top of a noun-first command tree. Adding a new top-level noun (e.g. `session`, `bql`) is a folder under `src/commands/` plus one line in `cli.ts`. Adding a verb is a single file under the existing folder.

### Directory Structure

```text
src/
├── cli.ts                          # Entrypoint — parses argv, registers nouns
├── version.ts                      # Hardcoded version (kept in sync with package.json)
├── errors.ts                       # UserFacingError + UsageError / PreconditionError /
│                                   #   CaptureError / ApiError + code discriminants
├── regions.ts                      # Production region codes (sfo / lon / ams) — as const
│
├── commands/                       # Layer 0 — argv parsing, flag wiring, output
│   │                               #   Every file under here is a CLI verb.
│   ├── profile/
│   │   ├── index.ts                # Registers the `profile` sub-tree
│   │   ├── list.ts                 # → GET /profiles
│   │   ├── show.ts                 # → GET /profile/:name
│   │   ├── upload.ts               # capture + POST /profile/upload
│   │   ├── refresh.ts              # capture + POST /profile/refresh
│   │   ├── inspect.ts              # capture + print summary (no upload)
│   │   ├── rename.ts               # → PUT /profile/:name
│   │   ├── delete.ts               # → DELETE /profile/:name
│   │   ├── terms.ts                # print the liability disclaimer (no network)
│   │   ├── launch.ts               # spawn user's real browser interactively
│   │   ├── sources/                # Custom-browser registry CRUD
│   │   └── exclude/                # Persistent domain-exclusion CRUD
│   ├── auth/                       # login / logout / status
│   └── config/                     # get / set / unset
│
├── cli-utils/                      # Cross-command helpers used by commands/
│   ├── client.ts                   # buildClient, addClientFlags, printJson,
│   │                               #   parseNonNegativeInt, collectRepeated
│   └── capture-runner.ts           # Shared capture flag wiring + runCapture()
│                                   #   for upload/refresh/inspect
│
├── capture/                        # Layer 1 — local extraction pipeline
│   ├── index.ts                    # Public: captureFromProfile() — copy → launch → cdp
│   ├── copy-profile.ts             # Filtered fs.cp, SingletonLock strip
│   ├── profile-lock.ts             # Windows cookie-DB lock probe, wording, bounded wait
│   ├── launch.ts                   # spawn browser headless with a CDP pipe, wait for a
│   │                               #   page target, kill tree (taskkill on Windows /
│   │                               #   SIGTERM POSIX)
│   ├── cdp-pipe.ts                 # Minimal CDP client over --remote-debugging-pipe
│   ├── cleanup.ts                  # Run-once capture cleanup shared with Ctrl-C
│   ├── cdp.ts                      # Storage.getCookies + per-origin LS / IDB capture,
│   │                               #   private-domain filter (mirrors server filter)
│   ├── exclusion.ts                # Suffix-match domain filter (config + flag merge)
│   └── types.ts                    # ProfileAuthState — MUST mirror the server wire contract
│
├── browsers/                       # Layer 1.5 — discovery + browser registry
│   ├── registry.ts                 # Built-in table: key → display name + per-OS paths
│   ├── discover.ts                 # Parse Local State, resolve --browser / --profile
│   ├── custom.ts                   # ~/.browserless/custom-browsers.json CRUD
│   ├── lock.ts                     # Cross-platform profile-busy detection
│   ├── paths.ts                    # macOS / Linux / Windows path helpers
│   └── password-store.ts           # Linux-only: detect/default --password-store
│
├── api/                            # Layer 2 — HTTP client over the server API
│   ├── client.ts                   # Authed fetch with AbortController timeout
│   ├── auth.ts                     # validateToken via GET /profiles?limit=1
│   ├── upload.ts                   # POST /profile/upload (strict create)
│   ├── refresh.ts                  # POST /profile/refresh (strict replace)
│   └── profiles.ts                 # GET / PUT / DELETE on /profile(s)
│
├── auth/                           # Local state — token + consent
│   ├── store.ts                    # Orchestrator: --token > env > keychain > 0600 file
│   ├── keychain.ts                 # @napi-rs/keyring wrapper with op-failed / unavailable
│   │                               #   discriminator (never silently falls back to file
│   │                               #   on a transient unlock error)
│   └── disclaimer.ts               # Liability prompt with 7-day TTL + interactive seam
│
├── config/                         # Local state — ~/.browserless/config.json
│   ├── paths.ts                    # Honors BROWSERLESS_CONFIG_DIR override
│   ├── schema.ts                   # User-managed vs CLI-managed key validation,
│   │                               #   sensitive-key marking
│   └── store.ts                    # Atomic read/write, mode 0600, mkdir mode 0700
│
└── test-helpers/                   # Mocha + Chai + Sinon shared seams
    ├── stub-server.ts              # In-process HTTP stub for api/* specs
    ├── mock-keychain.ts            # In-memory keyring — installFake / installNo /
    │                               #   installThrowing for op-failed branch coverage
    └── temp-home.ts                # Per-test $HOME with config-dir scoping

scripts/                            # Smoke tests + CI helpers (per-OS in ci.yml)
├── cli-smoke.mjs                   # End-to-end every command against a stub server
├── cli-capture-smoke.mjs           # Real-Chrome capture + roundtrip cookie reuse
├── cli-launch-smoke.mjs            # profile launch + signal forwarding
├── cli-keychain-smoke.mjs          # Real OS keychain (gnome / DPAPI / Keychain)
├── cli-discovery-smoke.mjs         # Real browser discovery across vendors
├── build-fixture-profile.js        # Build a minimal fake Chrome profile
└── ci/                             # Per-OS install scripts called from ci.yml
```

### The Three Layers

| Layer           | Responsibility                                                        | Knows about server? | Knows about FS?      | Knows about CLI argv?                 |
| --------------- | --------------------------------------------------------------------- | ------------------- | -------------------- | ------------------------------------- |
| `commands/`     | argv parsing, flag wiring, output formatting (`--json` / human)       | No (uses `api/`)    | No (uses `capture/`) | Yes                                   |
| `cli-utils/`    | Cross-command helpers — buildClient, addClientFlags, runCapture, etc. | No (uses `api/`)    | No (uses `capture/`) | Glue only — no `process.argv` parsing |
| `capture/`      | Local extraction pipeline; returns `ProfileAuthState`                 | No                  | Yes                  | No                                    |
| `api/`          | Authed HTTP over the Browserless server API                           | Yes                 | No                   | No                                    |
| `auth/+config/` | Token resolution + persisted user prefs                               | No                  | Yes                  | No                                    |
| `browsers/`     | Where browsers live, how to enumerate their profiles                  | No                  | Yes                  | No                                    |

`commands/` contains only CLI verbs — one file per verb, no exceptions. Cross-command helpers live in `cli-utils/`, which sits between `commands/` and the lower layers as the orchestration seam: `buildClient` wires resolved credentials, `runCapture` drives the disclaimer + capture pipeline + diagnostic stderr output for the three capture verbs. Keeping it out of `commands/` makes "folder = command map" absolute — a future contributor (or auto-registration script) doesn't need to know any underscore conventions.

`capture/` doesn't reach into `api/` at all; `api/` reaches into `capture/` only for the shared wire types (`ProfileAuthState` and friends) — there's no logic dependency, just a single import of the type produced on one side and consumed on the other. If `ProfileAuthState` ever needs to live somewhere else, a `src/types/` directory is the natural home; for now, keeping it next to the producer is the simpler tradeoff.

The lower layers can be exercised independently in unit tests against fixture profiles + a stub HTTP server, without ever spawning a real browser.

## Wire Contract with the Browserless Server

The CLI is one half of a contract; the Browserless server is the other half and the authority on its shape. Drift breaks uploads, often silently.

### Mirrored types

`src/capture/types.ts` mirrors the server's profile wire types: `ProfileAuthState` (what a capture produces) and `ProfileCaptureSettings` (the flags a profile was captured with, stored server-side so `profile refresh` can replay them). Every `ProfileCaptureSettings` member is optional:

```typescript
export interface ProfileCaptureSettings {
  browser?: string;
  profile?: string;
  excludeDomains?: string[]; // EFFECTIVE merged list, not the raw flags
  onlyDomains?: string[];
  keepDomains?: string[];
  autoFit?: boolean;
  passwordStore?: string;
  cliVersion?: string;
}

export interface ProfileAuthState {
  cookies: ProfileCookie[];
  origins: ProfileOriginStorage[];
}
```

On `profile refresh` the capture flags are optional: the CLI fetches the profile first, merges the stored settings under any flags you pass (explicit flag wins, lists replace wholesale), and prints what it will run.

Two constraints ride on `ProfileCaptureSettings`:

- **`excludeDomains` is the merged list**, built by `buildCaptureSettings(flags, result.diagnostics, verb)` — pass the diagnostics object, never `flags.excludeDomain`; the `Pick<CaptureDiagnostics, 'excludedDomains'>` parameter makes a bare array a compile error. On a refresh the CLI reads that stored list back itself (`mergeStoredSettings`) and suppresses the local config for the run, so the capture filters identically on a machine whose `excluded_domains` differs. Passing an explicit `--exclude-domain` **without** `--no-default-excludes` opts back out of that suppression, so the refreshing machine's own config is unioned in; the CLI says so on stderr. Passing both flags together suppresses the config and excludes only the listed patterns, which the CLI also states explicitly — the two facts are tracked separately because the post-merge `defaultExcludes` cannot distinguish them.
- **Adding a member needs server support first.** The server validates request bodies strictly and rejects unknown keys, so a CLI that sends a member the server doesn't know makes every upload _and_ refresh fail with a 400. `rethrowCaptureSettingsSkew` in `src/api/upload.ts` turns that 400 into an actionable message instead of retrying without the key.

The server also validates the scalar members: it rejects control characters, `$`, a backtick, a backslash and `!`. A real Chrome profile can be called `Bob's $tuff`, so the CLI drops an offending member with a warning rather than failing the upload. Domain-list entries are restricted to `[A-Za-z0-9*._-]`.

The CLI narrows `ProfileIndexedDBEntry.{key,value}` to `unknown`. JSON round-trips are identical; the narrower CLI type catches accidental reads at compile time. Do not widen it back.

### Mirrored caps

The server enforces these limits. The CLI mirrors them client-side (`MAX_SETTINGS_*` in `src/cli-utils/capture-runner.ts`, `MAX_ORIGINS_PER_RUN` / `MAX_IDB_DATABASES` / `MAX_IDB_ENTRIES` in `src/capture/cdp.ts`) so a capture never fails at upload time over metadata:

- Capture settings: at most 100 entries per domain list, 253 characters per domain, 255 characters per scalar member (browser / profile / passwordStore / cliVersion), 8 KB for the whole serialized object.
- Captured state: 2 MB for the serialized state, 50 origins per capture, 5 IndexedDB databases per origin, 1000 entries per object store.
- Profile names: at most 255 characters, matching `/^[^\s/?#]+$/`.

The server stays the authority — if the CLI's values drift below the server's, the upload succeeds with truncation; if they drift above, the server returns 400 on size.

### Routes the CLI calls

| Endpoint            | Method | CLI verb                                                                       | Failure shape                                                                            |
| ------------------- | ------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `/profile/upload`   | POST   | `profile upload`                                                               | 400 on name-collision / size / shape                                                     |
| `/profile/refresh`  | POST   | `profile refresh`                                                              | 404 if profile does not exist                                                            |
| `/profile/:name`    | GET    | `profile show`, `profile refresh` (reads the stored settings before capturing) | 404 if absent                                                                            |
| `/profile/:name`    | PUT    | `profile rename`                                                               | 400 / 404                                                                                |
| `/profile/:name`    | DELETE | `profile delete`                                                               | 404 if absent                                                                            |
| `/profiles`         | GET    | `profile list`                                                                 | -                                                                                        |
| `/profiles?limit=1` | GET    | `auth login` / `status`                                                        | Token validity probe — 200 ok, 401 invalid (`/pressure` isn't routed on the cloud build) |
| `/chromium/cli`     | WS     | `agent`                                                                        | Upgrade 401/403 → auth error; non-2xx → `ApiError`; see the agent wire contract below    |

Error bodies are JSON: `{ message: string }`. `apiFetch` parses this in `messageFromBody`; non-JSON bodies are truncated to 200 chars and surfaced verbatim. (The `agent` WS route is the one exception — it's a streaming protocol, not request/response; its contract is documented separately below.)

## Wire Contract with the Hosted Agent

The `agent` command speaks a second, **separate** wire contract over the `/chromium/cli` WebSocket. The server runs the LLM and drives the browser. Same rule as `ProfileAuthState`: **drift is silent.** The CLI parses inbound frames with `JSON.parse` and reads fields structurally, so a renamed field or a changed `end.result` shape just renders blank — it doesn't throw.

### Mirrored types

`src/agent/types.ts` mirrors the frame shapes the way `src/capture/types.ts` mirrors the profiles contract.

- **Control frames** (CLI → server, `AgentControlFrame`): `{type:'start', prompt}` opens the session with the first turn; `{type:'send', prompt}` is a follow-up turn or an awaited reply (MFA code); `{type:'stop'}` aborts the in-flight turn but leaves the session open.
- **Inbound frames** (server → CLI, `AgentFrameType`): `data` (assistant-text delta), `tool_call` / `tool_result` (the spinner line), `usage` (billing — no-op'd in the REPL), `awaiting_input` (paused for user input), `error`, `end`.
- **`end.result`** (`AgentEndResult`): `{ success: boolean; reason_code?: string; final_url?: string; evidence?: string }`. `null` when the turn produced no structured outcome (a plain chat reply — `text` carries it instead). `isAgentEndResult()` is the runtime guard `formatEndResult` uses before trusting the shape; under `--json` the whole `{type:'end', result}` is emitted verbatim.

### Connection + error mapping (`src/agent/ws-client.ts`)

- URL: `buildCliWsUrl` rewrites `http(s)`→`ws(s)`, trims trailing slashes, and appends `?token=…`. The browser session (proxy / profile) is chosen server-side; the CLI sends none.
- Connect-phase upgrade rejection: 401/403 → `PreconditionError('invalid-token')`, any other non-2xx → `ApiError`. Transport failures (DNS, refused, TLS) → `ApiError(status: 0)`.
- **Post-connect** socket errors re-emit as a synthetic `agent_error` (`code: 'ws-error'`, `retryable: false`) rather than the EventEmitter `error` event — which would throw with no listener. The server `error` frame is likewise re-emitted as `agent_error` (never the special `error` event).
- The REPL keeps the session alive **only** on an explicit `retryable: true`; a missing / malformed flag is treated as terminal ("when in doubt, throw").

## Usage Analytics

`src/telemetry/` emits one **`CLI Command Run`** event per invocation, plus `Profile Setup *` events for each `profile upload` / `profile refresh` attempt, to the Browserless **account API** (`POST /v2/cli/events`, default `https://api.browserless.io`) — _not_ the per-region browser server. The CLI can't resolve a token to an account or safely strip it, so the server does both: it authenticates the Bearer token, attributes the event to the account and sanitizes the properties before anything reaches analytics. The **raw token is never an event property** — it rides in the `Authorization` header for the server to resolve and discard.

Design rules (most enforced by specs — the `cli.ts` hook wiring is covered indirectly via `command-meta` + the facade specs):

- **Best-effort, bounded.** `postCliEvents` is a bounded (`~2 s`, `AbortController`) fetch that resolves to a boolean and swallows all errors. It never changes a command's exit code. It is _not_ instantaneous, though: because `cli.ts` drains the event loop instead of calling `process.exit()`, the process waits for this POST to settle (up to the flush timeout) before exiting — the command's own work is already done by then.
- **Authenticated + cloud-only.** Telemetry sends only when the command recorded a token this run (via `token-cache.ts` — set by `resolveToken`, and by `auth login` directly since it validates without `resolveToken`; so telemetry never triggers its own keychain read/prompt) **and** that token was resolved against a known production region. The region is taken from the recorded server (not a flag), so a self-hosted server's token can't be mismatched onto a cloud-bucketed event; self-hosted buckets to `custom` and is dropped. Commands that never record a token — local-only ones like `config` and offline `inspect` — aren't tracked. Both `auth login` and `auth status` are tracked (they resolve/validate a token).
- **Data minimization.** Flag **names** only (never values; the names are commander's camelCase attribute keys, e.g. `acceptTerms`, not `--accept-terms`), command path, status/exit-code/error-class, error code, error category and HTTP status (bounded codes, a closed category enum and a number — never the error message, response body or URL), duration, `cli_version`, os/arch/node, `is_ci`, the production region (`sfo|lon|ams` — self-hosted is dropped, never a raw URL), and a `cli_device_id` (a random UUID kept in its own file `~/.browserless/telemetry-device-id`, never in `config.json`). `Profile Setup *` events add an `attempt_id` (random, or `--attempt-id`) and a closed failure-reason enum. No URLs, domains, profile names, or tokens.
- **Opt-out precedence:** `BROWSERLESS_TELEMETRY_DISABLED` → `DO_NOT_TRACK` → `telemetry` config key (default on). Wired in `cli.ts` via commander `preAction` (capture) + `postAction`/the top-level `catch` (complete + flush).
- **CI and smoke runs must set `BROWSERLESS_TELEMETRY_DISABLED=1`** so test runs never show up as real usage.

## Key Subsystems

### Capture Lifecycle (`src/capture/`)

```text
profile upload --browser chrome --profile Default --name my-profile
  → resolveProfile()             [browsers/discover.ts]
  → ensureTermsAccepted()        [auth/disclaimer.ts]
  → buildTempUserDataDir()       [capture/copy-profile.ts] — filtered copy, strip Singletons; Windows cookie-DB lock gate first
  → launchBrowserWithPipe()      [capture/launch.ts]      — spawn user's binary, CDP on fd 3/4
  → startAnsweringBrowser()      [capture/launch.ts]      — restart once if the pipe stays silent for 10 s
  → waitForCdpPipe()             [capture/launch.ts]      — poll Target.getTargets over the pipe
  → captureViaCdp()              [capture/cdp.ts]         — Storage.getCookies + per-origin
  → applyExclusions()            [capture/exclusion.ts]   — client-side privacy filter
  → POST /profile/upload         [api/upload.ts]
  → killBrowser() + fs.rm tmp    [capture/launch.ts]
```

`captureFromProfile()` in `capture/index.ts` is the public entry point. Cleanup (`createCaptureCleanup` in `capture/cleanup.ts`) runs in `finally` so a thrown `CaptureError` still leaves a clean tmp dir behind, and the same run-once cleanup is wired to Ctrl-C / SIGTERM / Ctrl-Break via `onInterrupt` (`utils/interrupt.ts`). Leftovers from a killed run are removed by `sweepStaleTempDirs` at the start of the next capture.

### CDP over a pipe, never a port

Capture launches the browser with `--remote-debugging-pipe` and talks to it over file descriptors 3 and 4 (`capture/cdp-pipe.ts`). A `--remote-debugging-port` would let any local process attach to the headless copy of the profile and read its decrypted cookies without a keychain prompt; the pipe is reachable only through descriptors this process holds. Every tab shares the one connection as a flattened session (`Target.attachToTarget({ flatten: true })`). `profile launch` is the one exception and keeps a port on purpose: it exists to hand the user a CDP endpoint for their own tools.

### Filtered profile copy

A user's Chrome `Default/` can be 5–20 GB. The CLI skips `Cache/`, `Code Cache/`, `GPUCache/`, `GraphiteDawnCache/`, `ShaderCache/`, `Service Worker/`, `Crashpad/`, `optimization_guide_model_store/`. Singleton locks (`SingletonLock`, `SingletonSocket`, `SingletonCookie`) are unlinked from the copy so the headless instance can boot without colliding with a still-running user browser.

### Launch arg gating — the privacy promise

`CAPTURE_LAUNCH_ARGS` in `src/capture/launch.ts` is the ~30-flag suppression set (Sync, SafeBrowsing, telemetry, component update, etc.) applied **only when `headless === true`**. Running a copy of the user's profile _without_ these flags will let it hit Chrome Sync / Safe Browsing on the user's behalf — which desyncs session state in their real browser ("I'm randomly logged out until restart" symptom). The gate is pinned by `launch.spec.ts` for both branches; do not remove or relax the gating without updating the spec.

`profile launch` (interactive) deliberately passes `headless: false` and runs against the user's real user-data-dir so changes persist.

### CDP capture (`src/capture/cdp.ts`)

For each origin found in `Local Storage/leveldb/`:

1. Open a fresh CDP target and attach a flattened session on the pipe.
2. Enable `Fetch` and intercept every request with `Fetch.requestPaused`.
3. Navigate to `https://<origin>/` — the navigation request is intercepted and fulfilled with a stub `<html></html>` (we never actually hit the network).
4. `Page.evaluate` reads `localStorage` and enumerates IndexedDB.
5. Failures collect into `failedOrigins: FailedOriginCapture[]` — surfaced on stderr in `cli-utils/capture-runner.ts:runCapture`, never silently dropped.

### Cross-Platform Process Lifecycle (`src/capture/launch.ts`)

This is the most platform-divergent part of the CLI. Read carefully before touching.

| OS      | Kill mechanism                                                                                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | `SIGTERM` → 2 s grace → `SIGKILL`. Children reaped via parent exit.                                                                                                                                                                                            |
| Linux   | Same. Brave's zygote tree can take >2 s; we `child.unref()` + close stdio so Node's loop exits even if kernel hasn't reaped.                                                                                                                                   |
| Windows | `taskkill /T /F` via `spawnSync` (not `spawn`) so the OS torn down the tree before we return. Chrome renderer/utility processes use `CREATE_BREAKAWAY_FROM_JOB` and can briefly survive; they self-exit within ~30 s when their IPC pipes detect parent death. |

`killBrowser()` is idempotent (safe to call from `finally`) and bounded by a configurable `gracePeriodMs` (default 2 s — long enough for Chrome to flush the cookie SQLite WAL on shutdown).

### Cross-Platform Profile-Busy Detection (`src/browsers/lock.ts`)

Chromium's "is another instance running?" mechanism differs by OS:

| OS      | File            | Content                 | PID available?                         |
| ------- | --------------- | ----------------------- | -------------------------------------- |
| POSIX   | `SingletonLock` | Symlink to `host-N-pid` | Yes, parsed from target                |
| Windows | `lockfile`      | Empty marker            | No (real mutex is a Win32 named mutex) |

`checkProfileLock()` reads the right file per OS. `formatProfileBusyMessage(displayName, pid?)` builds the user-facing error so the PID-present / PID-absent branches stay testable in isolation.

`process.kill(pid, 0)` is the cross-platform liveness check — on Windows, libuv silently no-ops the destructive behaviour for signal 0, so a single call works everywhere with no platform branch needed.

#### Windows cookie-database lock (capture)

Chromium opens `<profile>\Network\Cookies` with `exclusive=1` on Windows only and unconditionally, so a copy fails with EBUSY/EPERM while any browser process for that user-data-dir lives (background included). `src/capture/profile-lock.ts` probes the cookie DB before copying (win32 only), words the error with `checkProfileLock()` (the Windows `lockfile` is `FILE_FLAG_DELETE_ON_CLOSE`, so it exists only while the browser runs), and waits up to 2 minutes when interactive. Non-interactive capture fails immediately when the browser runs, otherwise retries once after 1.5 seconds. Persistent locks throw `CaptureError` `'profile-file-locked'` (exit 4). POSIX capture with the browser open is unaffected.

## Configuration

### `~/.browserless/config.json`

Two kinds of keys live here. Mixing the two is intentional but means `config set` is scalar-only — list keys go through their dedicated subcommand, CLI-managed keys are written automatically.

| Key                 | Kind        | How to change                                                | Sensitive? |
| ------------------- | ----------- | ------------------------------------------------------------ | ---------- |
| `server`            | user scalar | `config set server <url>` (mutually exclusive with `region`) | -          |
| `region`            | user scalar | `config set region <sfo\|lon\|ams>`                          | -          |
| `terms_ttl_days`    | user scalar | `config set terms_ttl_days <n>`                              | -          |
| `telemetry`         | user scalar | `config set telemetry <true\|false>` (default on)            | -          |
| `excluded_domains`  | user list   | `profile exclude add/rm/list`                                | -          |
| `accepted_terms_at` | CLI-managed | bumped by disclaimer flow                                    | -          |
| `token_storage`     | CLI-managed | written by `auth login` based on keychain availability       | -          |
| `api_key`           | CLI-managed | written by `auth login` only when keychain is unavailable    | **Yes**    |

`config get api_key` redacts by default; pass `--show-sensitive` to print verbatim. Sensitive keys are marked on `KEY_SPECS` in `src/config/schema.ts`.

### Environment variables

| Variable                           | Purpose                                                                            | Notes                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSERLESS_TOKEN`                | Override token resolution (between `--token` flag and keychain)                    | -                                                                                                                                         |
| `BROWSERLESS_ACCEPT_TERMS`         | `=1` pre-accepts the disclaimer non-interactively                                  | Same effect as `--accept-terms`                                                                                                           |
| `BROWSERLESS_CONFIG_DIR`           | Override `~/.browserless/` location                                                | For CI / multi-tenant isolation without $HOME                                                                                             |
| `BROWSERLESS_DISABLE_KEYCHAIN`     | `=1` forces plaintext file storage                                                 | Audit / CI / no-GUI macOS runners                                                                                                         |
| `BROWSERLESS_CDP_WAIT_MS`          | Override 15 s CDP-readiness timeout                                                | macOS cold-boot needs more on CI                                                                                                          |
| `BROWSERLESS_TELEMETRY_DISABLED`   | `=1` disables usage analytics for the run                                          | Also `DO_NOT_TRACK=1`. Set in our own CI/smoke                                                                                            |
| `DO_NOT_TRACK`                     | `=1` disables usage analytics (cross-tool standard)                                | Same effect as `BROWSERLESS_TELEMETRY_DISABLED`                                                                                           |
| `BROWSERLESS_API_URL`              | Override the analytics ingest host; telemetry is skipped for untrusted URLs        | Default `https://api.browserless.io`; must use HTTPS on `browserless.io` or `*.browserless.io`, or HTTP(S) loopback for local development |
| `BROWSERLESS_ALLOW_INSECURE_HTTP`  | Allow sending the token over `http://` to a non-loopback server (prints a warning) | Only `=1` opts in; loopback HTTP is allowed automatically                                                                                 |
| `BROWSERLESS_TELEMETRY_TIMEOUT_MS` | Override the 2 s telemetry flush timeout                                           | Bounds the best-effort POST so it can't hang                                                                                              |
| `BROWSERLESS_TELEMETRY_DEBUG`      | `=1` logs a one-line stderr note per sent/dropped event                            | Diagnostic only; off by default                                                                                                           |
| `CI`                               | Standard CI flag — disclaimer refuses to prompt when set                           | Re-run with `--accept-terms`                                                                                                              |

### Token Resolution Order

`resolveToken()` in `src/auth/store.ts`:

```text
1. --token flag
2. $BROWSERLESS_TOKEN
3. OS keychain (account = server URL)
4. ~/.browserless/config.json (mode 0600)
5. throw PreconditionError('no-token')
```

The keychain entry is keyed by **server URL**, so one host can hold credentials for production-sfo, production-lon, and a self-hosted deployment side by side.

### Keychain Storage — Result Discriminator

`writeToKeychain` and `deleteFromKeychain` return a 3-state discriminator:

```typescript
type KeychainWriteResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' } // @napi-rs/keyring not installed / disabled — fall back to file
  | { ok: false; reason: 'op-failed'; error: string }; // keychain present, op rejected — surface to user
```

This is the critical invariant: on `op-failed`, `persistToken` throws `PreconditionError('keychain-write-failed')` rather than silently downgrading to plaintext. A transient lock prompt must not change the user's storage mode behind their back. `installThrowingKeychain` in `test-helpers/mock-keychain.ts` exercises this branch.

## Region Codes

`src/regions.ts` exports `REGION_URLS as const`, so `RegionCode` resolves to the literal union `'sfo' | 'lon' | 'ams'` rather than `string`. Adding a region is a one-line change here plus a spec entry — keep this list in sync with the regions Browserless ships production endpoints in.

`--region` is a shorthand for `--server`; passing both is `PreconditionError('server-region-conflict')`. Same applies to having `region` and `server` both set in config.

## Commands

Noun-first command tree. Reserved top-level nouns for future work: `session`, `bql`, `token`, `workspace` — don't claim those names for v1 features. The `agent` noun is the interactive hosted-agent chat.

### `profile` namespace

| Command                                                                               | Description                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `profile list [--limit N] [--offset N]`                                               | List cloud profiles for the current token                                 |
| `profile show <name>`                                                                 | Show one profile's metadata                                               |
| `profile upload --browser <k> --profile <p> --name <n>`                               | Capture + POST /profile/upload (strict create)                            |
| `profile refresh --name <n>` (capture flags optional — read from the stored settings) | GET /profile/:name, then capture + POST /profile/refresh (strict replace) |
| `profile inspect --browser <k> --profile <p>`                                         | Capture + print summary, no upload (debugging)                            |
| `profile launch --browser <k> --profile <p> [--headless]`                             | Spawn user's real browser interactively against real dir                  |
| `profile rename <old> <new>`                                                          | → PUT /profile/:name                                                      |
| `profile delete <name>`                                                               | → DELETE /profile/:name                                                   |
| `profile sources {list,add,rm}`                                                       | Custom-browser registry                                                   |
| `profile exclude {list,add,rm}`                                                       | Persistent domain exclusion list                                          |

### `auth` namespace

| Command              | Description                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth login [token]` | Validate via `GET /profiles?limit=1`, persist via keychain (or 0600 fallback). Reads from stdin if token omitted (keeps it out of shell history). |
| `auth logout`        | Clear keychain entry + config — both, atomically. Op-failed surfaces.                                                                             |
| `auth status`        | Show which token slot is in use and where it's stored                                                                                             |

### `config` namespace

| Command                               | Description                                                        |
| ------------------------------------- | ------------------------------------------------------------------ |
| `config get <key> [--show-sensitive]` | Read (sensitive keys redacted unless flagged)                      |
| `config set <key> <value>`            | Write a scalar user-managed key (server / region / terms_ttl_days) |
| `config unset <key>`                  | Remove a user-managed key (falls back to default)                  |

### `agent` namespace

| Command                                   | Description                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `agent [prompt] [--cloud-profile <name>]` | Open an interactive chat with the hosted agent (LLM runs server-side). |

Bare top-level noun (no verbs). Connects to `/chromium/cli` over WebSocket
(`src/agent/ws-client.ts`) and drives the REPL in `src/commands/agent/chat.ts`.
If the first prompt has login intent without a cloud profile, the CLI prints `LOGIN_TIP`.
The first `start` frame uses `buildFirstTurn()` to instruct the agent not to ask for secrets, while allowing one-time codes.
`--cloud-profile` is validated by `assertCloudProfileName()` and pre-checked with `GET /profile/:name` (404 → `cloud-profile-not-found`, exit 2) before the WebSocket opens.
With `--json`, only the
final `end` payload is emitted as JSON; the streaming events still render
during the turn.

Prompt history is persisted to `~/.browserless/agent_history` (mode 0600, cap
200 entries, see `src/agent/history.ts`) so the up arrow recalls previous task
prompts across sessions. MFA-code prompts use `linePrivate` (no
readline history), so one-time codes never land on disk. Pass `--no-history` to
disable the file entirely.

### Shared flags

Every verb that hits the cloud API uses `addClientFlags()`:

```text
--token <token>    API token (overrides env / keychain / file)
--server <url>     Browserless server URL
--region <code>    Production region — shorthand for --server
--json             Emit the server response as JSON
```

## Privacy Model

Two layers of protection — both enforced before the upload payload is serialized:

### Private-domain filter (`src/capture/cdp.ts:isPrivateCookieDomain` / `isPrivateOrigin`)

Defense in depth against accidentally uploading corp/intranet/local-network cookies. Mirrors the server's own filter. Drops:

- `localhost`, `*.localhost`, `*.local`, `*.internal`
- All IPv4 literals (even public-looking ones — IP-host cookies don't apply to a cloud account anyway)
- IPv6 literals (caught by `:` in hostname)
- Non-http(s) schemes (`file:`, `chrome-extension:`, `data:`, `javascript:`)
- Unparseable origins (drop defensively)

### User exclusion list (`src/capture/exclusion.ts`)

Suffix-match domain filter applied to cookies + origins. Long-lived list in `excluded_domains` config key + per-invocation `--exclude-domain <d>` flag. Match semantics:

- `example.com` matches `example.com`, `.example.com`, `www.example.com`, `.www.example.com`
- `*.example.com` is sugar for the default suffix behaviour — identical to `example.com`
- URL forms like `https://example.com/path` are normalized to the hostname

`--no-default-excludes` skips the config list for one invocation. On `profile refresh` what it persists depends on whether it is passed **alone**:

- **Alone** (no usable `--exclude-domain`): it clears the **stored** exclusion list **permanently** — the refreshed profile is written with `excludeDomains: []`, so every later flagless refresh replays "exclude nothing" and this machine's config no longer applies.
- **With a usable `--exclude-domain`**: the config stays suppressed, only the listed patterns are excluded, and those patterns — not `[]` — become the stored list. `printEffectiveSettings` says which of the two is in force, and tracks the facts separately (`configOff` vs `nothingExcluded`) because the post-merge `defaultExcludes` cannot tell them apart. It is the way to refresh a profile that _needs_ a domain its stored list excludes — at the cost of that list. The CLI says so on stderr before the capture runs. It clears only exclusions: `browser`, `profile`, `--only-domain`, `--keep-domain`, `--auto-fit` and `--password-store` are still inherited from the stored settings, so a stored `--only-domain` still discards everything outside it.

Because a refresh replaces `capture_settings` wholesale, opting out **alone** also stores the refreshed profile with **no** exclusion list. The CLI warns on stderr when that is about to happen, qualified on the 8 KB cap (the write is decided after the capture, so an over-cap run leaves the stored object intact); re-pass `--exclude-domain` to keep them. An empty stored list (`excludeDomains: []`) is meaningful and distinct from an absent one — it records "captured with no exclusions", and a later flagless refresh replays that rather than re-applying the refreshing machine's own config.

Diagnostics line is printed on stderr after every capture so the user sees what was filtered:

```text
> Captured 648 cookies, 12 origins in 19283ms
  → Excluded 47 cookies / 3 origins matching: chase.com, *.okta.com
```

## Disclaimer Flow (`src/auth/disclaimer.ts`)

Uploading authentication state needs an explicit, informed opt-in. Before every `profile upload` / `profile refresh` whose stored acknowledgment is older than 7 days (or absent), the user must type exactly `I accept` (or pass `--accept-terms` / `BROWSERLESS_ACCEPT_TERMS=1`).

Interactive seam: `DisclaimerOptions.prompt` and `isInteractive` let tests inject a deterministic answer without faking a real TTY. Without the seam, the interactive branch is unreachable in CI (the spec's `beforeEach` forces `CI=true`).

TTL is configurable via `--terms-ttl-days <n>`; `0` re-prompts every run.

## Browser Support

The CLI works against any **Chromium-based** browser. Firefox and Safari are architecturally excluded (different debug protocol, different cookie storage / decryption).

| Browser                             | Built-in?    | macOS path                                                  | Linux path                                                       | Windows path                                                                         |
| ----------------------------------- | ------------ | ----------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Google Chrome / Beta / Dev / Canary | ✅           | `~/Library/Application Support/Google/Chrome*`              | `~/.config/google-chrome*`                                       | `%LOCALAPPDATA%\Google\Chrome*\User Data`                                            |
| Microsoft Edge                      | ✅           | `~/Library/Application Support/Microsoft Edge`              | `~/.config/microsoft-edge`                                       | `%LOCALAPPDATA%\Microsoft\Edge\User Data`                                            |
| Brave                               | ✅           | `~/Library/Application Support/BraveSoftware/Brave-Browser` | `~/.config/BraveSoftware/Brave-Browser`                          | `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data` + per-user choco install path |
| Chromium (incl. Snap on Linux)      | ✅           | `~/Library/Application Support/Chromium`                    | `~/.config/chromium` + `/snap/chromium/current/.config/chromium` | `%LOCALAPPDATA%\Chromium\User Data`                                                  |
| Vivaldi / Opera / Arc               | ✅           | Various                                                     | Linux for most                                                   | Per-vendor                                                                           |
| Custom Chromium                     | (registered) | user-supplied via `profile sources add`                     | user-supplied                                                    | user-supplied                                                                        |

### Linux password-store auto-detection

Chromium can be configured with `--password-store={basic,gnome-libsecret,kwallet5}`. The CLI must launch with the same store the user's normal session uses or cookie decryption fails silently.

`src/browsers/password-store.ts` reads `<userDataDir>/Default/Preferences` (`profile.password_manager.encryption_backend`) then falls back to `XDG_CURRENT_DESKTOP` heuristics, then defaults to `basic` with a stderr warning. Override per-invocation with `--password-store <store>`.

## Error Model (`src/errors.ts`)

Exit code ladder:

| Class               | Exit | When                                                                                                         |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `UsageError`        | 2    | Bad args, missing required flag, unknown browser, invalid or unknown cloud profile (`agent --cloud-profile`) |
| `PreconditionError` | 3    | No token, terms not accepted, profile locked, corrupt config                                                 |
| `CaptureError`      | 4    | Profile copy (incl. a Windows-locked profile file: profile-file-locked) / browser launch / CDP failure       |
| `ApiError`          | 5    | Non-2xx response from the server (`status`, `body` preserved)                                                |
| (any other)         | 1    | Internal bug — stack trace printed                                                                           |

`PreconditionError` and `CaptureError` carry an optional `code` discriminant (e.g. `'no-token'`, `'keychain-write-failed'`, `'cdp-timeout'`, `'profile-busy'`) so tests / `--json` consumers / future error reporters can branch on cause without message-grepping. See `PreconditionCode` / `CaptureCode` in `src/errors.ts` for the canonical list — extend the union, don't free-text new codes.

`ApiError` carries `status` (HTTP code or `0` for network / timeout) and `body` (trimmed to 200 chars when non-JSON).

`apiFetch` maps `AbortError` (timeout) → `ApiError(status: 0, "timed out after Xms")` — surfaced fast so a hung server never blocks the CLI indefinitely. Default timeout is 30 s; per-request override via `RequestOptions.timeoutMs`.

## Development

### Local-dev setup

```bash
# One-shot: install + build + `npm link` so the `browserless` command
# resolves to your working tree. Re-run only if the link disappears.
npm install
npm run dev

browserless profile inspect --browser chrome --profile Default
```

After that, `npm run watch` in another shell rebuilds on save and the
linked binary picks up the new output immediately — no need to re-run
`npm run dev` between edits.

If you'd rather skip the link, `npm start` works too — but pass `--`
before flags or npm swallows them (this is what trips first-timers):

```bash
npm start -- profile inspect --browser chrome --profile Default
```

### Commands

```bash
# Install
npm install

# Build (tsc to build/)
npm run build

# Watch mode
npm run watch

# Run a built CLI (`--` separator is mandatory; npm eats `--flags` otherwise)
npm start -- profile list

# Lint (ESLint flat config in eslint.config.js)
npm run lint

# Format (prettier)
npm run prettier

# Unit tests (Mocha — builds first)
npm test
npm run test:grep -- "keychain"   # filter by describe/it name

# Smoke tests — run against real browsers / OS state (CI-driven)
npm run test:cli         # end-to-end every command against a stub server
npm run test:capture     # real Chrome capture + roundtrip cookie reuse
npm run test:launch      # profile launch + signal forwarding
npm run test:keychain    # real OS keychain
npm run test:discovery   # real browser discovery

# Cross-platform sanity check
npm run verify:platform
```

### Testing

- **Framework**: Mocha + Chai + Sinon
- **Spec location**: `*.spec.ts` co-located with source (e.g. `src/auth/store.ts` + `src/auth/store.spec.ts`)
- **Runner**: Mocha reads `build/**/*.spec.js` — the test script builds first, then runs. To target one file:
  ```bash
  npm run build && npx mocha --exit "build/auth/store.spec.js"
  ```
- **Cross-platform smoke**: `scripts/cli-*-smoke.mjs` run on Linux + macOS + Windows in `.github/workflows/ci.yml` for every PR. They spawn real Chrome/Brave/Edge against a fixture profile + stub server. Smoke retries are bounded (e.g. Windows `STATUS_STACK_BUFFER_OVERRUN` is retried once, then the suite fails) so the workaround can't mask a real regression.

### Testing Patterns

#### Unit tests against the file system

Use `setupTempHome()` from `src/test-helpers/temp-home.ts` to get a scoped `$HOME` + `BROWSERLESS_CONFIG_DIR`:

```typescript
import { setupTempHome, TempHome } from '../test-helpers/temp-home.js';

describe('config/store', () => {
  let home: TempHome;
  beforeEach(async () => {
    home = await setupTempHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });
  // ... tests use the real fs against a tmpdir
});
```

Do **not** stub `node:fs/promises` — the real fs is fast enough and catches platform quirks the stub would miss.

#### HTTP tests against a stub server

Use `startStubServer()` from `src/test-helpers/stub-server.ts`:

```typescript
import { startStubServer, StubServer } from '../test-helpers/stub-server.js';

describe('api/client', () => {
  let stub: StubServer;
  beforeEach(async () => {
    stub = await startStubServer();
  });
  afterEach(async () => {
    await stub.close();
  });

  it('appends the token', async () => {
    stub.setResponse(200, '{"ok":true}');
    await apiFetch(
      { server: stub.url, token: 'tok' },
      { method: 'GET', path: '/x' },
    );
    // assert against stub.recorded[0]
  });
});
```

For timeout / abort branches, spin up an `http.createServer` that holds responses open without ever replying — `apiFetch` with a small `timeoutMs` will abort and throw `ApiError(status: 0)`.

#### Keychain tests

`src/test-helpers/mock-keychain.ts` exposes three install patterns:

```typescript
installFakeKeychain({ 'https://x': 'tok' }); // in-memory map, ops succeed
installNoKeychain(); // module-unavailable (no @napi-rs/keyring)
installThrowingKeychain('access denied'); // present-but-throws — exercises op-failed branch
```

Always pair with `uninstallFakeKeychain()` in `afterEach`. Production code uses `__setKeyringForTests` under the hood — do not call that directly from tests.

#### Browser-spawning tests without a real browser

`src/capture/launch.spec.ts` spawns `process.execPath` (Node) as a stand-in for Chrome and inspects `child.spawnargs` synchronously before killing the child. `spawn()` populates spawnargs immediately, so the launch-flag construction is testable without a real browser process. The flags themselves are then asserted (`--headless=new`, `--disable-sync`, ...) — this is what pins the `CAPTURE_LAUNCH_ARGS` privacy gate.

For tests that genuinely need a browser, gate them behind smoke scripts in `scripts/` and the CI matrix — not unit tests.

#### Cross-platform skips

Unit tests that depend on POSIX semantics (mode bits, real signals) gate with `if (process.platform === 'win32') return;` at the top of the test. Smoke tests run on all three OSes; assertions that diverge by platform live there.

## Implementation Philosophy

### Honor the wire contract

The server is the authority on `ProfileAuthState`, the upload caps, the profile-name pattern, and the error shape. The CLI mirrors all of these in `src/capture/types.ts` and `src/capture/cdp.ts`. If you change one side, change the other — drift is silent until an upload fails in production.

Specifically: if the server tightens a cap or adds a field, the CLI's mirror must catch up before users on the old version start hitting confusing 400s. Conversely, if the CLI starts emitting a new field, the server's parser must accept it (or strip it) before the new CLI ships.

### Surface failures, never silently degrade

The most subtle bugs in a CLI like this come from "best-effort" code paths that swallow errors and leave the user with a wrong impression of success. The CLI takes the opposite stance:

- **Auth state mutations**: `auth login` writing to plaintext on a _transient_ keychain error is a silent security downgrade — refuse and surface. Only a missing keyring native binding (`unavailable`) is grounds for fallback. `auth logout` failing to delete from the keychain must throw, not silently wipe the config alone.
- **Config / source files**: corrupt JSON in `~/.browserless/{config,custom-browsers}.json` throws `PreconditionError`. Returning `{}` / `[]` would let the next write overwrite the user's settings.
- **Capture failures**: per-origin CDP errors collect into `CaptureDiagnostics.failedOrigins` and print on stderr. Never `catch { void err }`.
- **Network**: `apiFetch` always wraps in `ApiError` with structured `status` + `body`. Timeouts become `status: 0`.

When in doubt, throw — the top-level handler in `src/cli.ts` discriminates on `UserFacingError` for a clean exit, and any other throw prints a stack trace (signal: real bug, not a user-fixable condition).

### Don't fight cross-platform reality

Two-thirds of the recent commit history is "Windows fixed X" / "Linux's Snap chromium needs Y" / "macOS first-run hangs without Z". This is structural:

- Windows lockfiles, kill semantics, arg quoting, Defender pre-scan, breakaway-from-job utility processes — all genuinely different from POSIX.
- Linux distributes Chrome via multiple package systems (apt, Snap, Flatpak), each with different binary paths.
- macOS gates keychain access through code signatures; XPC handshakes can stall a cold launch.

When adding a feature: spell out the cross-platform branches up front, write the unit test against a fake of the platform-specific helper, add a smoke-test branch for the real-OS path. Don't ship "works on my Mac" — CI will tell you within an hour.

### The lower layers don't have logic dependencies on each other

`capture/` doesn't import from `api/` at all. `api/` imports from `capture/` only for the shared wire types (`ProfileAuthState` and friends) — pure type imports, no runtime dependency. `auth/` and `config/` don't import from either. The orchestration is in `commands/` and `cli-utils/`. If you find yourself reaching across a layer for something _other_ than a shared type, ask whether the abstraction is wrong before adding the import.

## Code Style Preferences

### Prefer Functional Programming Over Imperative

Favor functional patterns over imperative ones:

- `map` / `filter` / `reduce` over `for` loops
- Pure functions, no side effects where possible
- Return new arrays/objects, avoid in-place mutation
- Function composition over deep call chains

```typescript
// ✅ Functional
const ports = await Promise.all([
  pickFreePort(),
  pickFreePort(),
  pickFreePort(),
]);
const uniquePorts = new Set(ports);

// ❌ Imperative
const ports = [];
for (let i = 0; i < 3; i++) {
  ports.push(await pickFreePort());
}
```

### Prefer `const` Over `let` and `var`

- `const` — default
- `let` — only when reassignment is necessary
- `var` — never

```typescript
// ✅ Good
const result = await writeToKeychain(server, token);
if (result.ok) {
  /* ... */
}

// ❌ Bad
let result = await writeToKeychain(server, token); // never reassigned
var keychainAvailable = false; // never use var
```

### Comments — WHY only

Default to writing **no** comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, or behavior that would surprise a reader. If removing the comment wouldn't confuse a future reader, don't write it.

Concretely:

- Never restate what the code says (`// loop over files` above a `.forEach`).
- Never reference the current task / PR / fix ("// added for the X flow", "// see PR #123"). That belongs in the commit message, not the source — comments rot when the surrounding code moves but the reference stays.
- Document genuinely surprising platform behaviour. Good examples in this repo: the Windows lockfile-is-empty-marker note in `src/browsers/lock.ts`, the `CREATE_BREAKAWAY_FROM_JOB` note in `src/capture/launch.ts`, the `--host-resolver-rules` interaction in `scripts/cli-capture-smoke.mjs`.

### Error Type Discrimination

When throwing a `PreconditionError` or `CaptureError`, pass the `code` argument:

```typescript
// ✅ Good — discriminable cause
throw new PreconditionError(
  'No API token configured. Run `browserless auth login` to set one.',
  'no-token',
);

// ❌ Avoid — callers have to message-grep
throw new PreconditionError('No API token configured.');
```

Add new codes to the `PreconditionCode` / `CaptureCode` literal unions in `src/errors.ts` rather than free-texting strings.

## Git Conventions

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>[optional scope]: <description>
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, `build`, `style`.

Examples from this repo's history:

- `feat: --region sfo|lon|ams shortcut + region config key`
- `fix(capture): sweep Chrome processes by user-data-dir on Windows — renderers/utilities use CREATE_BREAKAWAY_FROM_JOB and survive taskkill /T`
- `test(ci): real-Chrome capture smoke (inspect/upload/refresh) across Linux/macOS/Windows`
- `fix(lock): check 'lockfile' on Windows, 'SingletonLock' on POSIX (Chrome uses different filenames)`

The body — when present — should explain _why_ the change was needed, especially for cross-platform fixes. The commit log is the canonical record of platform-specific quirks; future readers grep it.

### Pull Requests

PRs are squash-merged, so the PR title becomes the commit subject that release-please copies into `CHANGELOG.md`, the GitHub release and the npm package. Keep titles in Conventional Commits form (`pr-title.yml` checks it) and describe the change for users of the CLI.

`.github/pull_request_template.md` asks for a summary, related issues and a test plan.

### Pre-PR Sanity

Before opening a PR:

```bash
npm run build && npm run lint && npm test
```

Smoke tests run automatically on every PR via `.github/workflows/ci.yml` (matrix: Linux × macOS × Windows). The CI invariant: if a smoke test gets retried more than once via the built-in flake mitigations, the suite fails — the workaround is masking a real regression.

## Related Documentation

- **README**: `README.md` (user-facing CLI documentation)
- **Changelog**: `CHANGELOG.md` (generated by release-please)
- **Security policy**: `SECURITY.md` (how to report a vulnerability)
- **CI workflow security**: `docs/github-actions-security.md` (action pinning, lockfile, analyzers)
