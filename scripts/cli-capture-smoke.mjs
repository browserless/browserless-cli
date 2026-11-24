#!/usr/bin/env node
/**
 * Real-Chrome capture smoke test.
 *
 * Exercises the actual capture pipeline (`profile inspect`, `profile
 * upload`, `profile refresh`) against the CI runner's pre-installed
 * Chrome. Catches regressions in copy-profile / launch flags / CDP
 * wiring / exclusion / body construction / upload that the unit tests
 * and command-level smoke can't reach.
 *
 * Skips `profile launch` interactive flow — that one's still validated
 * via the manual smoke-{windows,macos,linux}.yml workflows because it
 * needs a real interactive browser session and the failure modes are
 * highly OS-specific.
 *
 * Run after `npm link`:
 *   $ npm run build && npm link && node scripts/cli-capture-smoke.mjs
 *
 * Exits non-zero on any failed assertion.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import CDP from 'chrome-remote-interface';
import { runCli } from './lib/run-cli.mjs';
import { createCheckHarness } from './lib/check.mjs';
import { detectChromeBinary } from './lib/detect-chrome.mjs';
import { setupSmokeEnv } from './lib/setup.mjs';

// ---------------------------------------------------------------------------
// Stub Browserless server (handles upload / refresh round-trip)
// ---------------------------------------------------------------------------

const startStubServer = () =>
  new Promise((resolve) => {
    const token = randomBytes(32).toString('hex');
    const profiles = {};
    // Monotonic timestamp — `new Date().toISOString()` can collide at ms
    // resolution when upload + refresh run back-to-back, so we add an
    // incrementing offset to guarantee each write produces a distinct value.
    let writeSeq = 0;
    const nextTimestamp = () => new Date(Date.now() + writeSeq++).toISOString();
    const send = (res, status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('token') !== token) {
        return send(res, 401, { message: 'Invalid token' });
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf-8');

      if (req.method === 'GET' && url.pathname === '/profiles') {
        return send(res, 200, Object.values(profiles));
      }
      // `profile refresh` reads the stored settings from here before it drives the
      // browser, so the stub has to model the real read route. The persisted
      // captureSettings come back so the merge has something to merge.
      const single = url.pathname.match(/^\/profile\/([^/]+)$/);
      if (req.method === 'GET' && single) {
        const found = profiles[decodeURIComponent(single[1])];
        if (!found) {
          return send(res, 404, {
            message: `Profile "${decodeURIComponent(single[1])}" was not found.`,
          });
        }
        // Refresh consumes these selectors before launching Chrome. Fail closed
        // at the read boundary, even if authenticated writes poisoned the state.
        const settings = found._capturedBody?.captureSettings;
        if (
          settings?.browser !== BROWSER_KEY ||
          settings?.profile !== 'Default'
        ) {
          return send(res, 400, { message: 'Unsafe smoke capture source' });
        }
        return send(res, 200, {
          ...found,
          captureSettings: found._capturedBody?.captureSettings ?? null,
        });
      }
      if (req.method === 'POST' && url.pathname === '/profile/upload') {
        const body = raw ? JSON.parse(raw) : {};
        if (profiles[body.name]) {
          return send(res, 400, {
            message: `Profile "${body.name}" already exists.`,
          });
        }
        const now = nextTimestamp();
        const profile = {
          id: `profile_${Math.random().toString(36).slice(2, 14)}`,
          name: body.name,
          cookieCount: body.state?.cookies?.length ?? 0,
          originCount: body.state?.origins?.length ?? 0,
          lastUsedAt: null,
          createdAt: now,
          updatedAt: now,
          _capturedBody: body,
        };
        profiles[body.name] = profile;
        return send(res, 200, profile);
      }
      if (req.method === 'POST' && url.pathname === '/profile/refresh') {
        const body = raw ? JSON.parse(raw) : {};
        const existing = profiles[body.name];
        if (!existing) {
          return send(res, 404, {
            message: `Profile "${body.name}" was not found.`,
          });
        }
        existing.cookieCount = body.state?.cookies?.length ?? 0;
        existing.originCount = body.state?.origins?.length ?? 0;
        existing.updatedAt = nextTimestamp();
        // Model `updateProfileState`: an omitted captureSettings leaves the stored
        // value alone. Replacing wholesale would let a refresh that stores nothing
        // look like it cleared the column, hiding the real preserve semantics.
        // `_sentCaptureSettings` is what makes the preserve path distinguishable: with
        // it modelled, comparing the stored value before/after a refresh that sent
        // nothing is a self-comparison and would pass while the CLI stopped sending.
        existing._sentCaptureSettings = 'captureSettings' in body;
        existing._capturedBody = {
          ...body,
          captureSettings:
            body.captureSettings === undefined
              ? existing._capturedBody?.captureSettings
              : body.captureSettings,
        };
        return send(res, 200, existing);
      }
      return send(res, 404, {
        message: `No route: ${req.method} ${url.pathname}`,
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        server,
        profiles,
        token,
      });
    });
  });

// ---------------------------------------------------------------------------
// Setup
//
// We deliberately do NOT override $HOME here. Chrome on macOS-latest CI
// runners hangs in Launch Services / XPC handshake when $HOME points at a
// fresh tmpdir lacking the usual ~/Library/... scaffolding. Instead:
//   - Isolate the CLI's config via BROWSERLESS_CONFIG_DIR.
//   - Register a custom browser source (name=cli-capture-chrome) at the
//     real Chrome binary + a freshly-seeded fake user-data-dir.
//   - Drive capture via `--browser cli-capture-chrome` so discovery never
//     touches the runner's real Chrome profile.
//
// CDP wait bumped to 60s — macOS runners can take >15s for Chrome's
// first-run XPC/Helper chatter before CDP listens.
// ---------------------------------------------------------------------------

const { tempRoot } = setupSmokeEnv({
  prefix: 'browserless-cli-capture-',
  cdpWaitMs: 60_000,
});
const fakeUserDataDir = path.join(tempRoot, 'chrome-user-data');

const chromeBin = detectChromeBinary();
if (!chromeBin) {
  console.error(
    `No Chrome binary found on ${process.platform}. Tested locations:`,
  );
  console.error(
    `  ${process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome (and friends)'}`,
  );
  console.error(
    'CI runners have Chrome pre-installed; if this fails locally, install Chrome or run via the manual smoke workflows.',
  );
  process.exit(1);
}
console.log(`Chrome binary: ${chromeBin}`);

mkdirSync(path.join(fakeUserDataDir, 'Default'), { recursive: true });
writeFileSync(path.join(fakeUserDataDir, 'Default', 'Preferences'), '{}');
writeFileSync(
  path.join(fakeUserDataDir, 'Local State'),
  JSON.stringify({ profile: { info_cache: { Default: { name: 'CI Test' } } } }),
);
console.log(`Seeded fake user-data-dir: ${fakeUserDataDir}`);

const BROWSER_KEY = 'cli-capture-chrome';

const stub = await startStubServer();
console.log(`Stub server: ${stub.url}`);

const VALID_TOKEN = stub.token;

const run = (args, opts) => runCli(args, { timeoutMs: 90_000, ...opts });

const harness = createCheckHarness();
const { check } = harness;

// Exercise isolation before any browser capture. All payloads are synthetic;
// never use an installed browser's source name even when testing rejection.
const isolationBody = {
  name: 'isolation-test',
  state: { cookies: [], origins: [] },
  captureSettings: {
    browser: BROWSER_KEY,
    profile: 'Default',
    excludeDomains: ['stored-only.example'],
  },
};
const stubRequest = (route, token, body) =>
  fetch(`${stub.url}${route}${token === null ? '' : `?token=${token}`}`, {
    method: body ? 'POST' : 'GET',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
assert.equal(
  (await stubRequest('/profile/upload', VALID_TOKEN, isolationBody)).status,
  200,
);
for (const token of [null, '', 'not-the-run-token']) {
  for (const [route, body] of [
    ['/profiles'],
    ['/profile/isolation-test'],
    ['/profile/upload', { ...isolationBody, name: 'unauthorized' }],
    ['/profile/refresh', { ...isolationBody, captureSettings: null }],
  ]) {
    await check(
      `stub rejects unauthorized ${route} (${token || 'missing/empty'})`,
      async () => {
        const before = JSON.stringify(stub.profiles);
        const response = await stubRequest(route, token, body);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { message: 'Invalid token' });
        assert.equal(JSON.stringify(stub.profiles), before);
      },
    );
  }
}
for (const captureSettings of [
  {
    ...isolationBody.captureSettings,
    browser: 'unregistered-synthetic-source',
  },
  { ...isolationBody.captureSettings, profile: '../outside-synthetic-profile' },
  { profile: 'Default' },
  { browser: BROWSER_KEY },
  null,
]) {
  await check(
    'stub refuses unsafe stored selectors before refresh can capture',
    async () => {
      assert.equal(
        (
          await stubRequest('/profile/refresh', VALID_TOKEN, {
            ...isolationBody,
            captureSettings,
          })
        ).status,
        200,
      );
      const response = await stubRequest(
        '/profile/isolation-test',
        VALID_TOKEN,
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        message: 'Unsafe smoke capture source',
      });
    },
  );
}
await check('stub still returns safe stored settings unchanged', async () => {
  assert.equal(
    (await stubRequest('/profile/refresh', VALID_TOKEN, isolationBody)).status,
    200,
  );
  const response = await stubRequest('/profile/isolation-test', VALID_TOKEN);
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).captureSettings,
    isolationBody.captureSettings,
  );
});
delete stub.profiles['isolation-test'];
delete stub.profiles.unauthorized;
// A broken safety boundary must stop the suite before it can launch Chrome.
if (harness.failed) {
  stub.server.close();
  rmSync(tempRoot, { recursive: true, force: true });
  harness.printSummary();
}

// Warmup pass on Windows. The first chrome.exe spawn after install
// occasionally crashes the CLI with STATUS_STACK_BUFFER_OVERRUN
// (exit 3221226505) — likely Windows Defender real-time scanning chrome.exe
// or our copied user-data-dir during first access. Touching the binary
// once with `chrome.exe --version` lets Defender pre-scan it before the
// first timed test. Bounded to 30 s so a hung warmup never blocks CI;
// no-op on POSIX where the flake doesn't reproduce.
if (process.platform === 'win32') {
  console.log('Warming up chrome.exe (Windows Defender pre-scan)…');
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(chromeBin, ['--version'], {
    stdio: 'ignore',
    timeout: 30_000,
    windowsHide: true,
  });
  if (r.error) console.log(`  warmup error (ignored): ${r.error.message}`);
}

// Configure CLI to talk to the stub server + log in + register the fake browser
await run(['config', 'set', 'server', stub.url]);
await run(['auth', 'login'], { stdin: VALID_TOKEN });
{
  const r = await run([
    'profile',
    'sources',
    'add',
    '--name',
    BROWSER_KEY,
    '--path',
    chromeBin,
    '--user-data-dir',
    fakeUserDataDir,
  ]);
  if (r.status !== 0) {
    console.error(
      `Failed to register custom browser source:\n${r.stderr}\n${r.stdout}`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Test: profile inspect (real Chrome, no upload)
// ---------------------------------------------------------------------------

console.log('\n[Capture] profile inspect against real Chrome');

await check(
  'profile inspect --browser chrome --profile Default --json captures cleanly',
  async () => {
    const r = await run(
      [
        'profile',
        'inspect',
        '--browser',
        BROWSER_KEY,
        '--profile',
        'Default',
        '--json',
      ],
      { timeoutMs: 90_000 },
    );
    if (r.status !== 0) {
      throw new Error(
        `exit ${r.status}, signal ${r.signal}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      throw new Error(`stdout was not valid JSON:\n${r.stdout}`);
    }
    if (!Array.isArray(parsed.cookies)) {
      throw new Error(`expected cookies array, got: ${JSON.stringify(parsed)}`);
    }
    if (!Array.isArray(parsed.origins)) {
      throw new Error(`expected origins array, got: ${JSON.stringify(parsed)}`);
    }
    console.log(
      `    captured: ${parsed.cookies.length} cookies, ${parsed.origins.length} origins`,
    );
  },
);

// ---------------------------------------------------------------------------
// Test: profile upload + refresh round-trip
// ---------------------------------------------------------------------------

console.log('\n[Capture] profile upload (real Chrome → stub server)');

await check(
  'profile upload --name capture-test creates a server-side profile',
  async () => {
    const r = await run(
      [
        'profile',
        'upload',
        '--browser',
        BROWSER_KEY,
        '--profile',
        'Default',
        '--name',
        'capture-test',
        '--accept-terms',
      ],
      { timeoutMs: 90_000 },
    );
    if (r.status !== 0) {
      throw new Error(
        `exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );
    }
    if (!stub.profiles['capture-test']) {
      throw new Error('stub server did not receive the upload');
    }
    const captured = stub.profiles['capture-test']._capturedBody;
    if (captured.name !== 'capture-test') {
      throw new Error(`wrong name: ${captured.name}`);
    }
    if (
      !Array.isArray(captured.state?.cookies) ||
      !Array.isArray(captured.state?.origins)
    ) {
      throw new Error(
        `malformed state: ${JSON.stringify(captured.state).slice(0, 200)}`,
      );
    }
  },
);

// The `buildCaptureSettings(opts, result.diagnostics, 'upload')` call site is
// reachable only from here. Passing raw flags instead of the merged diagnostics
// compiles, passes every unit spec, and degrades the stored list to the flags alone —
// which a flagless refresh then replays in place of the local config, so the machine's
// own config exclusions stop applying.
await check(
  'upload stores the MERGED exclusion list, not the raw flags',
  async () => {
    const add = await run(['profile', 'exclude', 'add', 'config-only.example']);
    if (add.status !== 0) {
      throw new Error(`exclude add failed: exit ${add.status}\n${add.stderr}`);
    }
    const r = await run(
      [
        'profile',
        'upload',
        '--browser',
        BROWSER_KEY,
        '--profile',
        'Default',
        '--name',
        'merged-list-test',
        '--exclude-domain',
        'flag-only.example',
        '--accept-terms',
      ],
      { timeoutMs: 90_000 },
    );
    if (r.status !== 0) {
      throw new Error(`exit ${r.status}\nstderr: ${r.stderr}`);
    }
    const body = stub.profiles['merged-list-test']?._capturedBody;
    if (!body) throw new Error('stub server did not receive the upload');
    const stored = body.captureSettings;
    if (!stored) {
      throw new Error(
        `no captureSettings on the wire; keys=${Object.keys(body)}`,
      );
    }
    const list = stored.excludeDomains ?? [];
    if (!list.includes('config-only.example')) {
      throw new Error(
        `config exclusion missing — raw flags were stored: ${JSON.stringify(list)}`,
      );
    }
    if (!list.includes('flag-only.example')) {
      throw new Error(`flag exclusion missing: ${JSON.stringify(list)}`);
    }
  },
);

// The verb argument is only observable here. Swapping 'refresh' for 'upload' at the
// call site compiles and passes every unit spec, and restores the message that
// wrongly told the user a rebuilt command would not include the stored filters.
await check(
  'an over-cap refresh reports that the stored settings were left alone',
  async () => {
    // The payload has to reach the CLI through the persistent exclusion list, not
    // argv: cmd.exe caps a command line at 8191 chars (CreateProcessW at 32767), and
    // the cheapest over-cap payload — 32 domains at the 253-char limit, ~8250 JSON
    // bytes — still needs ~8700 argv chars once each carries `--exclude-domain `. So
    // an over-cap argv is impossible on the Windows CI leg. The config file costs
    // no argv at all.
    const configPath = path.join(
      process.env.BROWSERLESS_CONFIG_DIR,
      'config.json',
    );
    const previous = existsSync(configPath)
      ? readFileSync(configPath, 'utf8')
      : null;
    const label = (i) =>
      `${Array.from({ length: 11 }, () => 'd'.repeat(19)).join('.')}-${i}.example`;
    const bulky = Array.from({ length: 100 }, (_, i) => label(i));
    writeFileSync(
      configPath,
      JSON.stringify({
        ...(previous ? JSON.parse(previous) : {}),
        excluded_domains: bulky,
      }),
    );

    try {
      const r = await run(
        [
          'profile',
          'refresh',
          '--browser',
          BROWSER_KEY,
          '--profile',
          'Default',
          '--name',
          'capture-test',
          '--accept-terms',
        ],
        { timeoutMs: 90_000 },
      );
      if (r.status !== 0) {
        throw new Error(`exit ${r.status}\nstderr: ${r.stderr}`);
      }
      if (!/left as it was/.test(r.stderr)) {
        throw new Error(`refresh wording missing from stderr:\n${r.stderr}`);
      }
      if (/nothing to replay/.test(r.stderr)) {
        throw new Error(`upload wording used on a refresh:\n${r.stderr}`);
      }
    } finally {
      if (previous === null) rmSync(configPath, { force: true });
      else writeFileSync(configPath, previous);
    }
  },
);

console.log('\n[Capture] profile refresh (re-upload existing)');

await check(
  'profile refresh --name capture-test updates the profile in place',
  async () => {
    // Snapshot scalar fields — the stub mutates the profile object in place,
    // so holding the object reference would give us a moving target.
    const beforeId = stub.profiles['capture-test'].id;
    const beforeUpdatedAt = stub.profiles['capture-test'].updatedAt;
    const r = await run(
      [
        'profile',
        'refresh',
        '--browser',
        BROWSER_KEY,
        '--profile',
        'Default',
        '--name',
        'capture-test',
        '--accept-terms',
      ],
      { timeoutMs: 90_000 },
    );
    if (r.status !== 0) {
      throw new Error(
        `exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );
    }
    const after = stub.profiles['capture-test'];
    if (!after) throw new Error('profile vanished from stub server');
    if (after.id !== beforeId) {
      throw new Error(`profile id changed: ${beforeId} → ${after.id}`);
    }
    if (after.updatedAt === beforeUpdatedAt) {
      throw new Error('updatedAt did not change after refresh');
    }
  },
);

// The core refresh path, and the exact command the Browserless dashboard hands
// the user: no source flags at all. Every unit spec exercises
// getProfile/mergeStoredSettings in isolation, so deleting either call from
// `commands/profile/refresh.ts` keeps all of them — and every other smoke check —
// green while the published CLI rejects every command the dashboard emits.
//
// The stored list is deliberately made to DIFFER from this machine's config first.
// While they matched, "replayed the stored list" and "recomputed from the local
// config" produced identical wire bytes, so the assertions below could not tell them
// apart — reverting the replay entirely left this check green.
await check(
  'profile refresh replays the STORED exclusion list, not this machine config',
  async () => {
    const seed = await run(
      [
        'profile',
        'refresh',
        '--browser',
        BROWSER_KEY,
        '--profile',
        'Default',
        '--name',
        'capture-test',
        '--no-default-excludes',
        '--exclude-domain',
        'stored-only.example',
        '--accept-terms',
      ],
      { timeoutMs: 90_000 },
    );
    if (seed.status !== 0) {
      throw new Error(
        `seed refresh exit ${seed.status}\nstderr: ${seed.stderr}`,
      );
    }
    const seeded =
      stub.profiles['capture-test']._capturedBody?.captureSettings
        ?.excludeDomains;
    if (JSON.stringify(seeded) !== JSON.stringify(['stored-only.example'])) {
      throw new Error(
        `seed did not store the expected list: ${JSON.stringify(seeded)}`,
      );
    }
  },
);

await check(
  'profile refresh with NO source flags reads them from the stored settings',
  async () => {
    const before = stub.profiles['capture-test'];
    const storedBefore = before._capturedBody?.captureSettings;
    if (!storedBefore?.browser || !storedBefore?.profile) {
      throw new Error(
        `precondition: stored settings lack browser/profile: ${JSON.stringify(storedBefore)}`,
      );
    }
    const beforeUpdatedAt = before.updatedAt;
    const r = await run(
      ['profile', 'refresh', '--name', 'capture-test', '--accept-terms'],
      { timeoutMs: 90_000 },
    );
    if (r.status !== 0) {
      throw new Error(
        `exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );
    }
    if (!/Refreshing with these effective settings/.test(r.stderr)) {
      throw new Error(`stderr did not announce the settings:\n${r.stderr}`);
    }
    // The values must be echoed, not just the header — a no-op merge would still
    // print the header.
    for (const expected of [
      `--browser ${storedBefore.browser}`,
      `--profile ${storedBefore.profile}`,
    ]) {
      if (!r.stderr.includes(expected)) {
        throw new Error(`stderr missing "${expected}":\n${r.stderr}`);
      }
    }
    const after = stub.profiles['capture-test'];
    if (after.updatedAt === beforeUpdatedAt) {
      throw new Error('updatedAt did not change after a flagless refresh');
    }
    // The replay has to reach the wire, not just stderr. Checked first, because the
    // stub preserves on omission: without this the value comparisons below compare the
    // stored object to itself and stay green if the CLI stops sending it entirely.
    if (after._sentCaptureSettings !== true) {
      throw new Error(
        'refresh sent no captureSettings — every later refresh would freeze the column',
      );
    }
    const sent = after._capturedBody?.captureSettings;
    if (sent?.browser !== storedBefore.browser) {
      throw new Error(
        `refresh stored browser ${JSON.stringify(sent?.browser)}, expected ${JSON.stringify(storedBefore.browser)}`,
      );
    }
    if (
      JSON.stringify(sent?.excludeDomains) !==
      JSON.stringify(storedBefore.excludeDomains)
    ) {
      throw new Error(
        `refresh did not replay the exclusion list: ${JSON.stringify(sent?.excludeDomains)} vs ${JSON.stringify(storedBefore.excludeDomains)}`,
      );
    }
    // The load-bearing half: this machine's config holds `config-only.example`, which
    // must NOT appear. Without this, unioning the local config back in — a
    // cross-machine leak — produces bytes indistinguishable from a correct replay.
    if ((sent?.excludeDomains ?? []).includes('config-only.example')) {
      throw new Error(
        `flagless refresh re-applied this machine's config: ${JSON.stringify(sent?.excludeDomains)}`,
      );
    }
  },
);

// The whole empty-list decision had no smoke coverage: no upload or refresh in this
// script passed --no-default-excludes, so nothing verified that `[]` reaches the wire
// or survives a later flagless refresh with a non-empty local config present.
await check(
  'an opted-out refresh stores [] on the wire and a flagless refresh keeps it',
  async () => {
    const optOut = await run(
      [
        'profile',
        'refresh',
        '--browser',
        BROWSER_KEY,
        '--profile',
        'Default',
        '--name',
        'capture-test',
        '--no-default-excludes',
        '--accept-terms',
      ],
      { timeoutMs: 90_000 },
    );
    if (optOut.status !== 0) {
      throw new Error(`exit ${optOut.status}\nstderr: ${optOut.stderr}`);
    }
    // The permanent write must be disclosed, whatever was stored before.
    if (!/stored with NO exclusion list/.test(optOut.stderr)) {
      throw new Error(
        `opt-out did not disclose the permanent write:\n${optOut.stderr}`,
      );
    }
    const afterOptOut =
      stub.profiles['capture-test']._capturedBody?.captureSettings
        ?.excludeDomains;
    if (JSON.stringify(afterOptOut) !== '[]') {
      throw new Error(
        `opt-out did not store an empty list: ${JSON.stringify(afterOptOut)}`,
      );
    }

    // `config-only.example` is still in this machine's config, so a flagless refresh
    // that re-derived instead of replaying the stored [] would pick it up.
    const flagless = await run(
      ['profile', 'refresh', '--name', 'capture-test', '--accept-terms'],
      { timeoutMs: 90_000 },
    );
    if (flagless.status !== 0) {
      throw new Error(`exit ${flagless.status}\nstderr: ${flagless.stderr}`);
    }
    const afterFlagless =
      stub.profiles['capture-test']._capturedBody?.captureSettings
        ?.excludeDomains;
    if (JSON.stringify(afterFlagless) !== '[]') {
      throw new Error(
        `flagless refresh did not preserve the empty list: ${JSON.stringify(afterFlagless)}`,
      );
    }
  },
);

await check(
  'profile refresh on missing profile returns exit 5 (404)',
  async () => {
    const r = await run(
      [
        'profile',
        'refresh',
        '--browser',
        BROWSER_KEY,
        '--profile',
        'Default',
        '--name',
        'does-not-exist',
        '--accept-terms',
      ],
      { timeoutMs: 90_000 },
    );
    // `getProfile` 404s before any capture runs → ApiError exit 5
    if (r.status !== 5) {
      throw new Error(
        `exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );
    }
  },
);

await check(
  'profile upload on duplicate name returns exit 5 (400)',
  async () => {
    const r = await run(
      [
        'profile',
        'upload',
        '--browser',
        BROWSER_KEY,
        '--profile',
        'Default',
        '--name',
        'capture-test',
        '--accept-terms',
      ],
      { timeoutMs: 90_000 },
    );
    if (r.status !== 5) {
      throw new Error(
        `exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Test: exclusion list applied during capture
// ---------------------------------------------------------------------------

console.log('\n[Capture] exclusion list applied');

await run(['profile', 'exclude', 'add', 'example.com']);

await check('profile inspect respects exclusion list', async () => {
  const r = await run(
    [
      'profile',
      'inspect',
      '--browser',
      BROWSER_KEY,
      '--profile',
      'Default',
      '--json',
    ],
    { timeoutMs: 90_000 },
  );
  if (r.status !== 0) {
    throw new Error(`exit ${r.status}\nstderr: ${r.stderr}`);
  }
  // The exclusion diagnostic goes to stderr — we asserted stdout is valid
  // JSON above. Here just verify the run completes cleanly with the
  // persistent exclusion list active.
  JSON.parse(r.stdout);
});

// ---------------------------------------------------------------------------
// End-to-end cookie capture + reuse roundtrip
//
// Verifies the full real-user flow: a profile that visited an authenticated
// site yields cookies via capture, and those cookies make a fresh browser
// session look authenticated to the same site. Without this, capture-smoke
// only proves the upload-body has the right shape — not that capture
// actually extracts usable data.
// ---------------------------------------------------------------------------

console.log('\n[Roundtrip] real cookies survive capture + reuse');

// Tiny in-process test site:
//   GET /login  → sets `auth=secret123` with Max-Age=3600 (persistent)
//   GET /whoami → returns JSON {authed: bool} based on the `auth` cookie
const startTestSite = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/login') {
        res.setHeader(
          'Set-Cookie',
          'auth=secret123; Path=/; Max-Age=3600; HttpOnly',
        );
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>logged in</body></html>');
        return;
      }
      if (url.pathname === '/whoami') {
        const cookie = req.headers.cookie ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authed: /auth=secret123/.test(cookie) }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, url: `http://127.0.0.1:${port}`, server });
    });
  });

const pickFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const bootChromeDirect = async (userDataDir, extraArgs = []) => {
  const port = await pickFreePort();
  const child = spawn(
    chromeBin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      '--disable-gpu',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return { child, port };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`Chrome CDP did not come up on port ${port} within 60s`);
};

// Close Chrome cleanly via CDP so cookie SQLite writes flush to disk.
// `child.kill('SIGTERM')` would leave in-memory cookies unflushed.
// Returns an object describing what we observed; tests can pass this to
// a failure reporter rather than relying on stderr scraping.
const closeChromeViaCdp = async (port, child) => {
  const observed = { connected: false, browserCloseSent: false };
  try {
    const client = await CDP({ port });
    observed.connected = true;
    try {
      await client.send('Browser.close');
      observed.browserCloseSent = true;
    } catch (err) {
      // Expected after Browser.close lands — the WebSocket drops as the
      // browser exits. Capture the message in case the round-trip cookie
      // test later flakes; the only signal we have for "did this work?"
      // is whether a subsequent reuse-the-cookie test sees a fresh login.
      observed.browserCloseError = err?.message ?? String(err);
    }
    try {
      await client.close();
    } catch (err) {
      observed.clientCloseError = err?.message ?? String(err);
    }
  } catch (err) {
    observed.connectError = err?.message ?? String(err);
  }
  // Belt-and-suspenders: ensure the process is reaped
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  return observed;
};

const site = await startTestSite();
// The capture pipeline filters cookies for "private" domains (localhost,
// IPs, .local, .internal) — see isPrivateCookieDomain in src/capture/cdp.ts.
// Use a synthetic public-looking hostname and Chrome's --host-resolver-rules
// to make it resolve to 127.0.0.1 so the cookies aren't filtered out.
const FAKE_HOST = 'capture-smoke.example';
const SITE_ORIGIN = `http://${FAKE_HOST}:${site.port}`;
const HOST_RESOLVER_RULES = `MAP ${FAKE_HOST} 127.0.0.1`;
console.log(`Test site: ${SITE_ORIGIN} (host-mapped → 127.0.0.1:${site.port})`);

const ROUNDTRIP_BROWSER_KEY = 'cli-roundtrip-chrome';
const roundtripUserDataDir = path.join(tempRoot, 'chrome-roundtrip-source');
mkdirSync(path.join(roundtripUserDataDir, 'Default'), { recursive: true });
writeFileSync(path.join(roundtripUserDataDir, 'Default', 'Preferences'), '{}');
writeFileSync(
  path.join(roundtripUserDataDir, 'Local State'),
  JSON.stringify({
    profile: { info_cache: { Default: { name: 'Roundtrip' } } },
  }),
);
{
  const r = await run([
    'profile',
    'sources',
    'add',
    '--name',
    ROUNDTRIP_BROWSER_KEY,
    '--path',
    chromeBin,
    '--user-data-dir',
    roundtripUserDataDir,
  ]);
  if (r.status !== 0) {
    console.error(`Failed to register roundtrip source:\n${r.stderr}`);
    process.exit(1);
  }
}

let captured = null;

await check(
  'capture extracts real cookies set during a browsing session',
  async () => {
    const { child, port } = await bootChromeDirect(roundtripUserDataDir, [
      `--host-resolver-rules=${HOST_RESOLVER_RULES}`,
    ]);
    // Browser.close drives the cookie SQLite WAL flush; if that step fails
    // the auth cookie probe below will be the only signal, and the
    // failure message will be opaque ("auth cookie missing"). Capture
    // close-diagnostics in the outer scope so we can attach them to a
    // downstream failure.
    let closeObserved;
    try {
      const client = await CDP({ port });
      try {
        await client.Page.enable();
        const loaded = new Promise((resolve) =>
          client.once('Page.loadEventFired', resolve),
        );
        await client.Page.navigate({ url: `${SITE_ORIGIN}/login` });
        await loaded;
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      closeObserved = await closeChromeViaCdp(port, child);
    }

    const r = await run(
      [
        'profile',
        'inspect',
        '--browser',
        ROUNDTRIP_BROWSER_KEY,
        '--profile',
        'Default',
        '--json',
      ],
      { timeoutMs: 90_000 },
    );
    if (r.status !== 0) {
      throw new Error(
        `profile inspect exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );
    }
    const parsed = JSON.parse(r.stdout);
    const authCookie = parsed.cookies.find((c) => c.name === 'auth');
    if (!authCookie) {
      throw new Error(
        `auth cookie missing from capture. ` +
          `closeChromeViaCdp observed: ${JSON.stringify(closeObserved)}. ` +
          `Got cookies: ${JSON.stringify(parsed.cookies.map((c) => `${c.name}@${c.domain}`))}`,
      );
    }
    if (authCookie.value !== 'secret123') {
      throw new Error(
        `auth cookie value: "${authCookie.value}", expected "secret123"`,
      );
    }
    console.log(
      `    captured ${parsed.cookies.length} cookies, ${parsed.origins.length} origins`,
    );
    captured = parsed;
  },
);

await check(
  'captured cookies authenticate a fresh browser session',
  async () => {
    if (!captured)
      throw new Error('skipped — capture step did not produce cookies');

    const reuseUserDataDir = path.join(tempRoot, 'chrome-roundtrip-reuse');
    mkdirSync(path.join(reuseUserDataDir, 'Default'), { recursive: true });
    writeFileSync(path.join(reuseUserDataDir, 'Default', 'Preferences'), '{}');
    writeFileSync(
      path.join(reuseUserDataDir, 'Local State'),
      JSON.stringify({
        profile: { info_cache: { Default: { name: 'Reuse' } } },
      }),
    );

    const { child, port } = await bootChromeDirect(reuseUserDataDir, [
      `--host-resolver-rules=${HOST_RESOLVER_RULES}`,
    ]);
    let body;
    try {
      const client = await CDP({ port });
      try {
        await client.Network.enable();
        const cookieParams = captured.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path ?? '/',
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          ...(c.expires ? { expires: c.expires } : {}),
          ...(c.sameSite ? { sameSite: c.sameSite } : {}),
        }));
        await client.send('Network.setCookies', { cookies: cookieParams });

        await client.Page.enable();
        const loaded = new Promise((resolve) =>
          client.once('Page.loadEventFired', resolve),
        );
        await client.Page.navigate({ url: `${SITE_ORIGIN}/whoami` });
        await loaded;
        const { result } = await client.send('Runtime.evaluate', {
          expression: 'document.body.innerText',
          returnByValue: true,
        });
        body = result.value;
      } finally {
        await client.close().catch(() => undefined);
      }
    } finally {
      await closeChromeViaCdp(port, child);
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`/whoami did not return JSON: ${body}`);
    }
    if (parsed.authed !== true) {
      throw new Error(
        `/whoami reports authed=${parsed.authed} — capture→reuse roundtrip failed`,
      );
    }
  },
);

await check(
  'capture while the source browser is still running: fails fast with guidance on Windows, succeeds elsewhere',
  async () => {
    const liveUserDataDir = path.join(tempRoot, 'chrome-live-source');
    mkdirSync(path.join(liveUserDataDir, 'Default'), { recursive: true });
    writeFileSync(path.join(liveUserDataDir, 'Default', 'Preferences'), '{}');
    writeFileSync(
      path.join(liveUserDataDir, 'Local State'),
      JSON.stringify({
        profile: { info_cache: { Default: { name: 'Live' } } },
      }),
    );
    const registered = await run([
      'profile',
      'sources',
      'add',
      '--name',
      'cli-live-chrome',
      '--path',
      chromeBin,
      '--user-data-dir',
      liveUserDataDir,
    ]);
    if (registered.status !== 0) throw new Error(`setup: ${registered.stderr}`);
    const { child, port } = await bootChromeDirect(liveUserDataDir, [
      `--host-resolver-rules=${HOST_RESOLVER_RULES}`,
    ]);
    try {
      const client = await CDP({ port });
      try {
        await client.Page.enable();
        const loaded = new Promise((resolve) =>
          client.once('Page.loadEventFired', resolve),
        );
        await client.Page.navigate({ url: `${SITE_ORIGIN}/login` });
        await loaded;
      } finally {
        await client.close().catch(() => undefined);
      }
      const cookieFiles = [
        path.join(liveUserDataDir, 'Default', 'Network', 'Cookies'),
        path.join(liveUserDataDir, 'Default', 'Cookies'),
      ];
      const deadline = Date.now() + 30_000;
      while (
        !cookieFiles.some((file) => existsSync(file)) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!cookieFiles.some((file) => existsSync(file))) {
        throw new Error('setup: cookie database not created within 30 s');
      }
      if (
        process.platform === 'win32' &&
        !existsSync(path.join(liveUserDataDir, 'lockfile'))
      ) {
        throw new Error('setup: running Chrome has no lockfile');
      }
      const r = await run([
        'profile',
        'inspect',
        '--browser',
        'cli-live-chrome',
        '--profile',
        'Default',
        '--json',
      ]);
      if (process.platform === 'win32') {
        if (
          r.status !== 4 ||
          r.stdout.trim() !== '' ||
          ![
            '(EBUSY)',
            'still running',
            'Continue running background apps',
            path.join('Default', 'Network', 'Cookies'),
          ].every((text) => r.stderr.includes(text))
        ) {
          throw new Error(
            `expected exit 4 and lock guidance, got ${r.status}: ${r.stderr}`,
          );
        }
      } else if (
        r.status !== 0 ||
        !Array.isArray(JSON.parse(r.stdout).cookies)
      ) {
        throw new Error(`live capture failed: exit ${r.status}: ${r.stderr}`);
      }
    } finally {
      await closeChromeViaCdp(port, child);
    }
  },
);

// ---------------------------------------------------------------------------
// [Multi-origin] capture size + exclusion flags
//
// Seeds a fixture profile with two heavyweight origins (~1.1 MB localStorage
// each) so the post-capture artifact exceeds the server's 2 MB cap. Then
// exercises the flags that act on the captured set:
//
//   --only-domain          allowlist a domain — drops everything else
//   --auto-fit             drop heaviest origins until under cap
//   --keep-domain          protect a domain from --auto-fit drops
//   --no-default-excludes  bypass the persistent exclusion list for one run
//
// Without two distinct, heavy origins these flags are unobservable — the
// unit tests cover the trimming/filtering math (trim-state.spec.ts,
// exclusion.spec.ts) but the CLI plumbing (flag → runCapture → stderr
// diagnostics → mutated state) is only validated end-to-end here.
// ---------------------------------------------------------------------------

console.log('\n[Multi-origin] capture size + exclusion flags');

const ORIGIN_A_HOST = 'origin-a.capture-smoke.example';
const ORIGIN_B_HOST = 'origin-b.capture-smoke.example';
const MULTI_HOST_RULES = `MAP ${ORIGIN_A_HOST} 127.0.0.1, MAP ${ORIGIN_B_HOST} 127.0.0.1`;

const MULTI_BROWSER_KEY = 'cli-multi-origin-chrome';
const multiUserDataDir = path.join(tempRoot, 'chrome-multi-origin-source');
mkdirSync(path.join(multiUserDataDir, 'Default'), { recursive: true });
writeFileSync(path.join(multiUserDataDir, 'Default', 'Preferences'), '{}');
writeFileSync(
  path.join(multiUserDataDir, 'Local State'),
  JSON.stringify({
    profile: { info_cache: { Default: { name: 'MultiOrigin' } } },
  }),
);
{
  const r = await run([
    'profile',
    'sources',
    'add',
    '--name',
    MULTI_BROWSER_KEY,
    '--path',
    chromeBin,
    '--user-data-dir',
    multiUserDataDir,
  ]);
  if (r.status !== 0) {
    console.error(`Failed to register multi-origin source:\n${r.stderr}`);
    process.exit(1);
  }
}

// Seed each origin with ~1.1 MB of localStorage so the combined artifact
// (origins + cookies + envelope) lands above the 2 MB server cap. The
// content is just `x` repeated — the exact bytes don't matter, only the
// serialized contribution.
const HEAVY_BYTES = 1_100_000;
{
  const { child, port } = await bootChromeDirect(multiUserDataDir, [
    `--host-resolver-rules=${MULTI_HOST_RULES}`,
  ]);
  try {
    for (const host of [ORIGIN_A_HOST, ORIGIN_B_HOST]) {
      const client = await CDP({ port });
      try {
        await client.Page.enable();
        const loaded = new Promise((resolve) =>
          client.once('Page.loadEventFired', resolve),
        );
        await client.Page.navigate({
          url: `http://${host}:${site.port}/login`,
        });
        await loaded;
        // Build the heavy string inside the page rather than shipping it
        // through CDP — `'x'.repeat(N)` is one short eval, vs. a multi-MB
        // RPC payload that would stress the protocol JSON encoder.
        await client.send('Runtime.evaluate', {
          expression: `localStorage.setItem('heavy', 'x'.repeat(${HEAVY_BYTES}))`,
          returnByValue: true,
          awaitPromise: false,
        });
      } finally {
        await client.close().catch(() => undefined);
      }
    }
  } finally {
    await closeChromeViaCdp(port, child);
  }
}

// The exclusion-list test earlier in this file added "example.com" to the
// persistent list. Our fake hosts use *.capture-smoke.example, which would
// match a suffix filter on "example.example" but NOT "example.com" —
// nothing to clean up, but be explicit so the assertions are independent.
{
  const list = await run(['profile', 'exclude', 'list']);
  if (
    list.stdout.includes(ORIGIN_A_HOST) ||
    list.stdout.includes(ORIGIN_B_HOST)
  ) {
    throw new Error(
      `multi-origin test hosts must not be on the persistent exclude list at start; got:\n${list.stdout}`,
    );
  }
}

// Every multi-origin assertion below assumes BOTH heavy origins were
// captured — that's what pushes the artifact past the 2 MB cap. On a busy
// runner a transient CDP target-creation 500 (or a per-origin timeout)
// occasionally drops one origin; the capture pipeline correctly reports it
// ("N origin(s) failed to capture") and continues, but that degraded-yet-
// valid result breaks these cap-dependent assertions. Re-run the inspect a
// couple of times until the environmental flake clears. CI-only safety net
// — the CLI's capture behaviour is intentionally unchanged.
const MULTI_MAX_RETRIES = 2;
const inspectMulti = async (extraArgs) => {
  for (let attempt = 1; ; attempt++) {
    const r = await run(
      [
        'profile',
        'inspect',
        '--browser',
        MULTI_BROWSER_KEY,
        '--profile',
        'Default',
        '--json',
        ...extraArgs,
      ],
      { timeoutMs: 120_000 },
    );
    if (
      attempt <= MULTI_MAX_RETRIES &&
      /origin\(s\) failed to capture/.test(r.stderr)
    ) {
      console.log(
        `    [flake] multi-origin inspect dropped an origin (attempt ${attempt}/${MULTI_MAX_RETRIES + 1}); retrying`,
      );
      continue;
    }
    return r;
  }
};

const expectStderrContains = (r, needle) => {
  if (!r.stderr.includes(needle)) {
    throw new Error(
      `expected stderr to contain ${JSON.stringify(needle)}.\nstderr (last 800 chars):\n${r.stderr.slice(-800)}`,
    );
  }
};

await check(
  'inspect captures both heavy origins and reports cap-hit',
  async () => {
    const r = await inspectMulti([]);
    if (r.status !== 0) {
      throw new Error(
        `exit ${r.status}\nstderr: ${r.stderr}\nstdout (first 500 chars): ${r.stdout.slice(0, 500)}`,
      );
    }
    const parsed = JSON.parse(r.stdout);
    const seenA = parsed.origins.some((o) => o.origin.includes(ORIGIN_A_HOST));
    const seenB = parsed.origins.some((o) => o.origin.includes(ORIGIN_B_HOST));
    if (!seenA || !seenB) {
      throw new Error(
        `expected both origins; got: ${parsed.origins.map((o) => o.origin).join(', ')}`,
      );
    }
    // Without --auto-fit the runner reports the cap-hit on stderr but still
    // emits the full state on stdout (inspect doesn't upload).
    expectStderrContains(r, 'exceeds the 2.00 MB server cap');
  },
);

await check('inspect --only-domain keeps only the allowed origin', async () => {
  const r = await inspectMulti(['--only-domain', ORIGIN_A_HOST]);
  if (r.status !== 0) {
    throw new Error(`exit ${r.status}\nstderr: ${r.stderr}`);
  }
  expectStderrContains(r, '--only-domain');
  const parsed = JSON.parse(r.stdout);
  if (parsed.origins.length !== 1) {
    throw new Error(
      `expected exactly 1 surviving origin, got ${parsed.origins.length}: ${parsed.origins.map((o) => o.origin).join(', ')}`,
    );
  }
  if (!parsed.origins[0].origin.includes(ORIGIN_A_HOST)) {
    throw new Error(
      `expected ${ORIGIN_A_HOST}, got ${parsed.origins[0].origin}`,
    );
  }
  // --only-domain is state-wide: cookies for the other origin must also
  // be dropped, not just origin storage.
  const strayCookies = parsed.cookies.filter((c) =>
    c.domain.includes(ORIGIN_B_HOST),
  );
  if (strayCookies.length > 0) {
    throw new Error(
      `expected no cookies for ${ORIGIN_B_HOST}, got ${strayCookies.length}`,
    );
  }
});

await check(
  'inspect --auto-fit drops origins until under the cap',
  async () => {
    const r = await inspectMulti(['--auto-fit']);
    if (r.status !== 0) {
      throw new Error(`exit ${r.status}\nstderr: ${r.stderr}`);
    }
    expectStderrContains(r, '--auto-fit: dropped');
    const parsed = JSON.parse(r.stdout);
    // Two heavy origins, cap is 2 MB, each origin is ~1.1 MB → after one
    // drop the artifact fits. Asserting exactly 1 survivor pins the
    // pass-fail behaviour (any future regression that leaves both, or
    // drops both, is caught).
    if (parsed.origins.length !== 1) {
      throw new Error(
        `expected exactly 1 surviving origin after auto-fit, got ${parsed.origins.length}`,
      );
    }
  },
);

await check(
  'inspect --auto-fit --keep-domain protects the named origin',
  async () => {
    const r = await inspectMulti([
      '--auto-fit',
      '--keep-domain',
      ORIGIN_A_HOST,
    ]);
    if (r.status !== 0) {
      throw new Error(`exit ${r.status}\nstderr: ${r.stderr}`);
    }
    expectStderrContains(r, '--auto-fit: dropped');
    const parsed = JSON.parse(r.stdout);
    const survived = parsed.origins.map((o) => o.origin);
    if (!survived.some((o) => o.includes(ORIGIN_A_HOST))) {
      throw new Error(
        `--keep-domain failed to protect ${ORIGIN_A_HOST}; survivors: ${survived.join(', ')}`,
      );
    }
    if (survived.some((o) => o.includes(ORIGIN_B_HOST))) {
      throw new Error(
        `expected ${ORIGIN_B_HOST} to be dropped; survivors: ${survived.join(', ')}`,
      );
    }
  },
);

// --no-default-excludes: add ORIGIN_A to the persistent list and verify
// the default run drops it but the override re-captures it.
await run(['profile', 'exclude', 'add', ORIGIN_A_HOST]);

await check('inspect honours the persistent exclusion list', async () => {
  const r = await inspectMulti([]);
  if (r.status !== 0) {
    throw new Error(`exit ${r.status}\nstderr: ${r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout);
  if (parsed.origins.some((o) => o.origin.includes(ORIGIN_A_HOST))) {
    throw new Error(
      `expected ${ORIGIN_A_HOST} excluded; got: ${parsed.origins.map((o) => o.origin).join(', ')}`,
    );
  }
  if (!parsed.origins.some((o) => o.origin.includes(ORIGIN_B_HOST))) {
    throw new Error(`expected ${ORIGIN_B_HOST} to survive`);
  }
});

await check(
  'inspect --no-default-excludes bypasses the list for one run',
  async () => {
    const r = await inspectMulti(['--no-default-excludes']);
    if (r.status !== 0) {
      throw new Error(`exit ${r.status}\nstderr: ${r.stderr}`);
    }
    const parsed = JSON.parse(r.stdout);
    if (!parsed.origins.some((o) => o.origin.includes(ORIGIN_A_HOST))) {
      throw new Error(
        `expected ${ORIGIN_A_HOST} to re-appear with --no-default-excludes`,
      );
    }
    if (!parsed.origins.some((o) => o.origin.includes(ORIGIN_B_HOST))) {
      throw new Error(`expected ${ORIGIN_B_HOST} to be present`);
    }
  },
);

// Restore exclusion-list state so downstream additions to this script
// don't inherit a surprise.
await run(['profile', 'exclude', 'rm', ORIGIN_A_HOST]).catch(() => undefined);

// ---------------------------------------------------------------------------
// Cleanup + report
// ---------------------------------------------------------------------------

site.server.close();
stub.server.close();
rmSync(tempRoot, { recursive: true, force: true });

harness.printSummary();
