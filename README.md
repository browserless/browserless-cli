<!-- markdownlint-disable commands-show-output first-line-h1 no-emphasis-as-heading no-inline-html -->

<div align="center">
  <a href="https://browserless.io" align="center">
    <center align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/browserless/browserless/main/assets/logo-white.svg" width="600">
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/browserless/browserless/main/assets/logo.svg" width="600">
        <img src="https://raw.githubusercontent.com/browserless/browserless/main/assets/logo.svg" alt="Browserless logo" width="600">
      </picture>
    </center>
  </a>

  <h3>Capture authenticated browser profiles for Browserless — straight from your terminal.</h3>

  <p>
    <a href="https://www.npmjs.com/package/@browserless.io/cli">
      <img src="https://img.shields.io/badge/📦_Install_via_npm-CB3837?style=for-the-badge" alt="Install via npm" />
    </a>
    &nbsp;&nbsp;
    <a href="https://docs.browserless.io/baas/features/authenticated-profiles">
      <img src="https://img.shields.io/badge/📘_Dev_Docs-5C6AC4?style=for-the-badge" alt="Developer Docs" />
    </a>
    &nbsp;&nbsp;
    <a href="https://browserless.io/">
      <img src="https://img.shields.io/badge/🧪_Try_on_Cloud-4A90E2?style=for-the-badge" alt="Try on Cloud" />
    </a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@browserless.io/cli">
      <img src="https://img.shields.io/npm/v/@browserless.io/cli?style=flat-square" alt="npm version" />
    </a>
    <a href="https://www.npmjs.com/package/@browserless.io/cli">
      <img src="https://img.shields.io/npm/dm/@browserless.io/cli?style=flat-square" alt="npm downloads" />
    </a>
    <a href="https://nodejs.org">
      <img src="https://img.shields.io/node/v/@browserless.io/cli?style=flat-square" alt="Node version" />
    </a>
    <a href="https://status.browserless.io/">
      <img src="https://img.shields.io/badge/Status-Operational-success?style=flat-square" alt="Status" />
    </a>
  </p>
</div>

<br>

## 📋 Table of Contents

- [Get Started in Seconds](#-get-started-in-seconds)
- [Capture Commands](#-capture-commands)
- [Privacy & Domain Filtering](#-privacy--domain-filtering)
- [Managing Artifact Size](#-managing-artifact-size)
- [Custom Chromium Browsers](#-custom-chromium-browsers)
- [Hosted Agent](#-hosted-agent)
- [Shared Flags](#-shared-flags)
- [Configuration](#-configuration)
- [Environment Variables](#-environment-variables)
- [Usage Analytics](#-usage-analytics)
- [Exit Codes](#-exit-codes)
- [Why use the CLI?](#-why-use-the-cli)
- [Contributing](#-contributing)
- [Security](#-security)
- [Licensing](#-licensing)

## 🚀 Get Started in Seconds!

### Step 1: Install

```bash
npm install -g @browserless.io/cli
```

Requires Node.js ≥ 24.

### Step 2: Log in

```bash
# Recommended: pipe the token via stdin (or paste it at the prompt)
echo $TOKEN | browserless auth login

# Also works, but a token passed as an argument is visible to other local
# users in the process list and lands in your shell history
browserless auth login <your-token>
```

Tokens are stored in your **OS keychain** when available (Keychain on
macOS, libsecret on Linux, DPAPI on Windows) and fall back to a
mode-0600 file at `~/.browserless/config.json` when not.

```bash
browserless auth status    # who am I, where is my token stored?
browserless auth logout    # wipe credentials (keychain + file)
```

### Step 3: Capture a profile

```bash
# Capture from your local Chrome and upload it as a cloud profile
browserless profile upload \
  --browser chrome --profile Default --name my-chrome
```

> **Windows:** quit the browser completely before capturing — including its icon in the taskbar notification area. Windows keeps the browser's cookie database locked while it runs. If it is still running, the CLI says so; in an interactive terminal it waits up to 2 minutes and continues once the browser has closed.

**✅ Success!** Any Browserless cloud session can now start _already
authenticated_ by attaching `?profile=my-chrome` to its launch URL.

### Picking a server

By default the CLI talks to `https://production-sfo.browserless.io`.
Two ways to point it elsewhere:

```bash
# Production regions — short codes for production-<code>.browserless.io
browserless config set region sfo                # San Francisco (default)
browserless config set region lon                # London
browserless config set region ams                # Amsterdam

# Or a full URL — for self-hosted / staging deployments
browserless config set server https://my-browserless.example.com
```

Per-invocation overrides: `--region <code>` or `--server <url>`.
Passing both flags (or having both keys set in config) is an error —
they're mutually exclusive.

## 🗂 Capture Commands

> **First-run note (macOS only).** The first time you run `profile upload`
> or `profile refresh`, macOS may show a one-time Keychain prompt:
> _"Google Chrome wants to access key 'Chrome Safe Storage' in your
> keychain"_. This is the launched Chrome reading its own existing
> keychain entry — not the CLI asking for new access. Click
> **Always Allow** and you won't see it again.
>
> **Liability disclaimer.** The first `profile upload` or `profile refresh`
> shows a one-screen disclaimer and asks you to type `I accept`. The
> acknowledgment is recorded and re-prompted every 7 days by default.
> Use `--accept-terms` (or `BROWSERLESS_ACCEPT_TERMS=1`) in scripts /
> non-interactive shells; `--terms-ttl-days <n>` tunes the re-prompt
> window (0 to re-prompt every run).
> Scripts and agents can print the notice with `browserless profile terms`
> and show it to the user. Agents must wait for explicit user approval before
> passing `--accept-terms`.

```bash
# Print the liability disclaimer (for scripts and agents that pass --accept-terms)
browserless profile terms

# Discover local browser profiles
browserless profile sources list

# Capture and upload as a new cloud profile (strict create)
browserless profile upload \
  --browser chrome --profile Default --name my-chrome

# Re-capture and overwrite an existing cloud profile (strict replace)
browserless profile refresh \
  --browser chrome --profile Default --name my-chrome

# Capture and print a summary without uploading (handy for debugging)
browserless profile inspect --browser chrome --profile Default

# Launch your real browser interactively against the local profile —
# useful for fixing up auth state (logging in, dismissing dialogs)
# before re-running `profile refresh`. Source browser must be closed.
browserless profile launch --browser chrome --profile Default

# Manage cloud profiles
browserless profile list
browserless profile list --limit 50 --offset 0
browserless profile show my-chrome
browserless profile rename my-chrome my-chrome-v2
browserless profile delete my-chrome-v2
```

### `--browser` and `--profile`

In a terminal, `profile upload` and `profile inspect` can omit either flag. The CLI lists matching local profiles and asks you to pick a number, or uses the only match and prints which one it chose. The picker needs a terminal on both stdin and stderr. In scripts and CI, supply both flags; if either is missing, the error lists the flags for the matching profiles. If refresh has no saved source, it can ask in a terminal too.

Versions newer than 0.7.0 save the browser key and profile directory actually captured, even when you typed a display name. Refresh fails if that saved directory is gone rather than matching another profile's display name. If you override the browser, choose a profile from the new browser or pass `--profile` explicitly. Source builds still stamped 0.7.0 preserve typed selectors and replay picked directories using the legacy matcher, which can also match display names.

`--browser` accepts either the short key or the display name in quotes:

| Key             | Display name                                      |
| --------------- | ------------------------------------------------- |
| `chrome`        | Google Chrome                                     |
| `chrome-beta`   | Google Chrome Beta                                |
| `chrome-dev`    | Google Chrome Dev                                 |
| `chrome-canary` | Google Chrome Canary                              |
| `brave`         | Brave                                             |
| `edge`          | Microsoft Edge                                    |
| `vivaldi`       | Vivaldi                                           |
| `opera`         | Opera                                             |
| `arc`           | Arc                                               |
| `chromium`      | Chromium (incl. Snap on Linux)                    |
| (custom)        | whatever you registered via `profile sources add` |

The match is case-insensitive: `--browser CHROME`, `--browser Chrome`,
and `--browser "google chrome"` all resolve to the same entry.

`--profile` accepts either the user-visible profile name from `Local
State` (e.g. `Personal`, `Work`) or the on-disk directory name
(`Default`, `Profile 1`). If multiple profiles match (rare — display
names should be unique within a browser), the CLI prints all candidates
so you can disambiguate by passing the directory name.

## 🔒 Privacy & Domain Filtering

Cookies and origin storage for sensitive domains can be filtered out
**locally**, before the upload leaves your machine — Browserless never
sees them:

```bash
browserless profile exclude add chase.com
browserless profile exclude add "*.okta.com"
browserless profile exclude list
browserless profile exclude rm chase.com
```

Suffix-match: `example.com` matches `example.com`, `.example.com`,
`www.example.com`, and `sub.www.example.com`. The optional `*.` prefix
is the default behaviour — `*.example.com` is identical to
`example.com`. Non-ASCII / IDN domains are accepted; they're
punycode-normalized to match how Chrome stores them.

Or one-shot for a specific upload (repeatable):

```bash
browserless profile upload \
  --browser chrome --profile Default --name demo \
  --exclude-domain chase.com --exclude-domain "*.okta.com"
```

Use `--no-default-excludes` to ignore the persistent list for a single
invocation (e.g. when refreshing a profile that _needs_ a domain that's
normally excluded).

> **In addition to your list**, the CLI always filters out cookies and
> origin storage for `localhost`, `*.local`, `*.internal`, and IP-literal
> hosts. These aren't user-configurable — they protect against accidentally
> uploading intranet / corp / local-network state that would never apply
> to a cloud session anyway.

## 📦 Managing Artifact Size

The Browserless server caps uploaded profiles at **2 MB** of serialized
state (cookies + per-origin localStorage + IndexedDB). Real-world
profiles usually fit easily, but a handful of heavyweight sites
(figma.com, google.com, vendor analytics) can push you over. When the
capture exceeds the cap, the CLI prints the heaviest origins on stderr
and the upload returns HTTP 400 — pick one of the flags below to fit
under it.

| Flag                | Effect                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--auto-fit`        | Drop the heaviest origins (largest first) until the artifact fits under the cap. Cookies are never dropped.                                            |
| `--keep-domain <d>` | Protect a domain from `--auto-fit` drops — suffix-match (same syntax as `--exclude-domain`), repeatable.                                               |
| `--only-domain <d>` | Allowlist: capture only cookies / origins matching these domains, discard everything else. Suffix-match, repeatable. Applies after `--exclude-domain`. |

```bash
# Auto-drop heaviest origins so the upload succeeds, but never drop google.com
browserless profile upload \
  --browser chrome --profile Default --name demo \
  --auto-fit --keep-domain google.com --keep-domain github.com

# Capture only the sites you care about — everything else is discarded locally
browserless profile upload \
  --browser chrome --profile Default --name demo \
  --only-domain github.com --only-domain "*.atlassian.net"
```

`--auto-fit` reports each origin it dropped on stderr; `--only-domain`
reports how many cookies / origins it kept and dropped. If `--auto-fit`
can't reach the cap because every remaining heavy origin is protected
by `--keep-domain`, the CLI tells you which `--keep-domain` to relax.

## 🧩 Custom Chromium Browsers

Register any Chromium-based binary the built-in registry doesn't know
about (Thorium, Cromite, a self-built Chromium, ...):

```bash
browserless profile sources add \
  --name my-chromium \
  --path /path/to/chromium \
  --user-data-dir /path/to/user-data-dir
browserless profile sources rm my-chromium
```

The `--name` doubles as both the display name and the `--browser <key>`
value. Registrations are stored in `~/.browserless/custom-browsers.json`.
If the binary or `user-data-dir` later goes missing, `profile sources
list` flags the entry under "Registered custom browsers with missing
paths" so you can clean it up with `profile sources rm`.

## 🤖 Hosted Agent

`browserless agent` opens an interactive chat with the Browserless hosted
agent. The model runs on Browserless and drives a cloud browser for you; the
terminal shows its replies and each browser action as it happens.

```bash
# Start a chat, optionally with the first task
browserless agent "find the opening hours of the Louvre"

# Scripts: stdout carries only the final result as JSON (progress goes to stderr)
browserless agent "find the opening hours of the Louvre" --json

# Save a signed-in local browser once, then use its cloud profile
browserless profile upload --browser chrome --profile Personal --name github
browserless agent --cloud-profile github "star browserless/browserless on GitHub"
```

- Follow-up messages continue the same session. Ctrl-C stops the current
  turn; press it again (or send an empty line) to exit.
- When the agent pauses for input — for example a one-time code — the CLI
  prompts you for it.
- For signed-in tasks, upload a signed-in browser with
  `browserless profile upload --name <name> --browser <browser> --profile <local-profile>` and pass that cloud name with
  `browserless agent --cloud-profile <name>`. The CLI validates the name and
  checks that it exists before starting the agent. Run `browserless profile list`
  to see your cloud profiles. A login-looking first message without the flag
  prints a tip instead of asking for credentials. The agent is instructed never
  to ask for passwords or other secrets and to stop when sign-in is needed.
  If the saved profile is no longer signed in, update it with
  `browserless profile refresh --name <name>`.
- Prompts you type are kept in `~/.browserless/agent_history` (mode 0600,
  last 200) so the up arrow recalls them across sessions; one-time codes
  are never written there. `--no-history` turns the
  file off.

## ⚙️ Shared Flags

Every command that hits the cloud API accepts:

| Flag              | Effect                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--token <tok>`   | Override token resolution (flag > env > keychain > config file). Visible in the process list; prefer `BROWSERLESS_TOKEN` for scripts |
| `--server <url>`  | Override the configured server URL                                                                                                   |
| `--region <code>` | `sfo` / `lon` / `ams` — shorthand for `--server`                                                                                     |
| `--json`          | Emit the server response as JSON (script-friendly)                                                                                   |

Capture commands (`upload`, `refresh`, `inspect`) also accept:

| Flag                    | Effect                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--exclude-domain <d>`  | Append a domain to the exclusion list for this run (repeatable)                                                                               |
| `--no-default-excludes` | Skip the persistent exclusion list for this run                                                                                               |
| `--only-domain <d>`     | Allowlist: capture only domains matching this pattern (repeatable, applies after `--exclude-domain`)                                          |
| `--auto-fit`            | If the artifact exceeds the 2 MB server cap, drop the heaviest origins until it fits (see [Managing Artifact Size](#-managing-artifact-size)) |
| `--keep-domain <d>`     | Domain that `--auto-fit` must never drop (repeatable)                                                                                         |
| `--accept-terms`        | Pre-accept the liability disclaimer                                                                                                           |
| `--terms-ttl-days <n>`  | Override the re-prompt TTL for this run (0 = every run)                                                                                       |
| `--password-store <s>`  | Linux only — pass `basic` / `gnome-libsecret` / `kwallet5` through to the launched browser if auto-detection picks wrong                      |

## 🛠 Configuration

`~/.browserless/config.json` is created with mode 0600 on first use.
Manage user-managed keys via the commands below; CLI-managed keys are
written automatically and not user-editable.

| Key                 | Kind        | How to change                                                                                            |
| ------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `server`            | user scalar | `browserless config set server <url>` (mutually exclusive with `region`)                                 |
| `region`            | user scalar | `browserless config set region <sfo\|lon\|ams>`                                                          |
| `terms_ttl_days`    | user scalar | `browserless config set terms_ttl_days <n>` (default 7)                                                  |
| `telemetry`         | user scalar | `browserless config set telemetry <true\|false>` (default on) — see [Usage Analytics](#-usage-analytics) |
| `excluded_domains`  | user list   | `browserless profile exclude add/rm/list`                                                                |
| `accepted_terms_at` | CLI-managed | written when you accept the disclaimer                                                                   |
| `token_storage`     | CLI-managed | written by `auth login` (`keychain` or `file`)                                                           |
| `api_key`           | CLI-managed | written by `auth login` only when keychain is unavailable                                                |

```bash
browserless config get server
browserless config get api_key                        # redacted by default
browserless config get api_key --show-sensitive       # print verbatim
browserless config set terms_ttl_days 30
browserless config unset region
```

`config set` is scalar-only — list keys (`excluded_domains`) go through
`profile exclude`, CLI-managed keys can't be set directly (they have
side-effects the CLI itself owns).

## 🌍 Environment Variables

| Variable                           | Effect                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BROWSERLESS_TOKEN`                | Use this token without a stored credential (overrides keychain + file)                                                                                                                                       |
| `BROWSERLESS_ACCEPT_TERMS`         | `1` to pre-accept the liability disclaimer                                                                                                                                                                   |
| `BROWSERLESS_CONFIG_DIR`           | Override `~/.browserless/` location (CI / multi-tenant)                                                                                                                                                      |
| `BROWSERLESS_DISABLE_KEYCHAIN`     | `1` to force plaintext config-file storage even if the keychain works                                                                                                                                        |
| `BROWSERLESS_CDP_WAIT_MS`          | Override the 15 s CDP-readiness timeout (raise on slow CI runners)                                                                                                                                           |
| `BROWSERLESS_TELEMETRY_DISABLED`   | `1` to disable usage analytics for the run (see [Usage Analytics](#-usage-analytics))                                                                                                                        |
| `DO_NOT_TRACK`                     | `1` also disables usage analytics (cross-tool standard)                                                                                                                                                      |
| `BROWSERLESS_API_URL`              | Override the analytics endpoint (default `https://api.browserless.io`); must use HTTPS on `browserless.io` or `*.browserless.io`, or HTTP(S) loopback for local development. Telemetry is skipped otherwise. |
| `BROWSERLESS_ALLOW_INSECURE_HTTP`  | `1` to allow sending the token over `http://` to a non-loopback server (prints a warning)                                                                                                                    |
| `BROWSERLESS_TELEMETRY_TIMEOUT_MS` | Override the 2 s analytics flush timeout (ignored unless a positive number)                                                                                                                                  |

## 📊 Usage Analytics

The CLI reports lightweight usage so we know which commands to invest in
(and which to leave alone). It's on by default and easy to turn off.

**What is sent**, once per command, and only when the command both
authenticated with your token and targeted a Browserless cloud region:

- the command that ran (e.g. `profile upload`) and the **names** of the flags
  you passed — never their values
- the outcome: `ok` / `error`, the exit code, and on failure the error class,
  a short error code (e.g. `cdp-timeout`, `not-found`), a category (e.g.
  `network`) and the server's HTTP status when there is one — never the error message
- duration, CLI version, OS / architecture / Node major, whether it's running
  under CI
- the production region (`sfo` / `lon` / `ams`) — never a raw server URL
- a random per-install id (`cli_device_id`), stored in
  `~/.browserless/telemetry-device-id`
- for `profile upload` / `profile refresh`, a few setup-progress events
  (`Profile Setup Method Selected`, `Profile Setup Started`,
  `Profile Setup Ready`, `Profile Save Submitted`, and
  `Profile Setup Failed` with a short reason code) that share a random
  `attempt_id`. Pass `--attempt-id <UUID>` to keep your own id across
  retries; the same id is sent to the Browserless server with the upload as
  the `x-browserless-attempt-id` header

**What's never in the analytics data:** your API token, profile names,
captured URLs or domains, cookies, or any captured auth state. The token is
sent only as the request's `Authorization` header, so the Browserless API can
attribute the event to your account (usage is recorded per account, not
anonymously), and is **stripped before anything reaches analytics** — it's
never an event property. Commands that don't contact a
cloud region aren't tracked at all — that includes **self-hosted servers**
(`--server <url>`), where nothing is sent, and local-only commands (e.g.
`config`, offline `inspect`).

**Opt out** any of these ways:

```bash
browserless config set telemetry false   # persistent
BROWSERLESS_TELEMETRY_DISABLED=1 ...      # per-run
DO_NOT_TRACK=1 ...                        # per-run (cross-tool standard)
```

## 🚦 Exit Codes

| Code | Meaning                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                                                     |
| 1    | Internal bug — prints a stack trace                                                                                         |
| 2    | Bad arguments (`UsageError`)                                                                                                |
| 3    | Precondition failed — no token, disclaimer declined, profile busy, corrupt config (`PreconditionError`)                     |
| 4    | Local capture pipeline failed — copy (including a browser still running on Windows) / browser launch / CDP (`CaptureError`) |
| 5    | Server returned a non-2xx response (`ApiError`)                                                                             |

## 💡 Why use the CLI?

**Sharing a logged-in browser session with a cloud worker is painful.**

Cookies live in OS-encrypted SQLite. localStorage and IndexedDB are
spread across LevelDB on disk. Manually re-logging in on every cloud
session is busywork — and rolling your own cookie export usually ends
in _"why am I randomly logged out of everything?"_ when Chrome Sync
realises a copy of the profile woke up on a server farm.

**The CLI does this once, safely.** It launches a _temporary copy_ of
your profile in a controlled-headless mode that suppresses Chrome Sync
/ Safe Browsing / component-update traffic, reads cookies +
localStorage + IndexedDB via CDP, applies your domain-exclusion list
**locally**, and uploads only the result. Your real profile is never
touched; sensitive domains never leave your machine.

Once uploaded, any Browserless cloud session can attach the profile
via `?profile=<name>` and start _already authenticated_.

## 🤝 Contributing

Pull requests are welcome. [AGENTS.md](AGENTS.md) is the contributor guide —
architecture, local setup, testing patterns and conventions (coding agents
read the same file). Before opening a PR:

```bash
npm run build && npm run lint && npm test
```

PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)
and become the changelog entry.

## 🔒 Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
Don't open a public issue for a security problem.

## 📜 Licensing

The Browserless CLI is open source under the [MIT License](LICENSE).
Using it with the hosted Browserless service is also covered by your
Browserless account terms and the
[privacy policy](https://www.browserless.io/privacy-policy).

<div align="center">

**Happy capturing!**

Need help? Reach out to us at **support@browserless.io**

</div>
