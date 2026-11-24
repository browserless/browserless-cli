#!/usr/bin/env node
/**
 * CLI integration smoke test.
 *
 * Invokes every browserless CLI command end-to-end on whatever OS this
 * runs on. Uses a temp HOME to keep tests hermetic, an in-process stub
 * HTTP server to satisfy cloud-talking commands, and a seeded fake
 * user-data-dir to satisfy local-discovery commands. Does NOT launch a
 * real browser — capture/launch flows are out of scope for CI smoke
 * (they need a working display server / dbus / etc., which CI runners
 * don't reliably provide).
 *
 * Run after `npm link` so `browserless` is on PATH:
 *   $ npm run build && npm link && node scripts/cli-smoke.mjs
 *
 * Exits non-zero on any failed assertion.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { runCli } from './lib/run-cli.mjs';
import { createCheckHarness } from './lib/check.mjs';

// ---------------------------------------------------------------------------
// Stub Browserless server
// ---------------------------------------------------------------------------

/** Minimal Browserless API stub. Tracks state so rename/delete have effects. */
const startStubServer = () =>
  new Promise((resolve) => {
    /** @type {Record<string, any>} */
    const profiles = {
      'demo-profile': {
        id: 'profile_demo',
        name: 'demo-profile',
        cookieCount: 4,
        originCount: 1,
        lastUsedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    };
    const requests = [];
    const agentConnections = [];
    const agentFrames = [];
    const agentHooks = { onEnd: () => {} };

    const send = (res, status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;
      requests.push(pathname);
      const token = url.searchParams.get('token');

      if (!token) return send(res, 401, { message: 'Missing token' });
      if (token === 'invalid-token')
        return send(res, 401, { message: 'Unauthorized' });

      if (req.method === 'GET' && pathname === '/profiles') {
        // Mirror the server's /profiles?limit=&offset= contract so smoke can
        // exercise the CLI's pagination wiring. Real server orders by
        // created_at DESC; we sort by name for predictable test assertions.
        const all = Object.values(profiles).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        const limitRaw = url.searchParams.get('limit');
        const offsetRaw = url.searchParams.get('offset');
        const offset = offsetRaw !== null ? Number(offsetRaw) : 0;
        const start = offset;
        const end = limitRaw !== null ? offset + Number(limitRaw) : undefined;
        return send(res, 200, all.slice(start, end));
      }

      if (req.method === 'GET' && pathname.startsWith('/profile/')) {
        const name = decodeURIComponent(pathname.slice('/profile/'.length));
        const p = profiles[name];
        if (!p)
          return send(res, 404, { message: `Profile "${name}" was not found` });
        return send(res, 200, p);
      }

      if (req.method === 'PUT' && pathname.startsWith('/profile/')) {
        const oldName = decodeURIComponent(pathname.slice('/profile/'.length));
        if (!profiles[oldName]) {
          return send(res, 404, {
            message: `Profile "${oldName}" was not found`,
          });
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const newProfile = { ...profiles[oldName], name: body.name };
        delete profiles[oldName];
        profiles[body.name] = newProfile;
        return send(res, 200, newProfile);
      }

      if (req.method === 'DELETE' && pathname.startsWith('/profile/')) {
        const name = decodeURIComponent(pathname.slice('/profile/'.length));
        const p = profiles[name];
        if (!p)
          return send(res, 404, { message: `Profile "${name}" was not found` });
        delete profiles[name];
        return send(res, 200, p);
      }

      return send(res, 404, { message: `No route: ${req.method} ${pathname}` });
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      agentConnections.push(req.url);
      const url = new URL(req.url, 'http://x');
      if (
        url.pathname !== '/chromium/cli' ||
        url.searchParams.get('token') !== 'valid-test-token'
      ) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data) => {
          const frame = JSON.parse(data.toString());
          agentFrames.push(frame);
          if (frame.type === 'start') {
            ws.send(
              JSON.stringify({
                type: 'end',
                result: { success: true, reason_code: 'SUCCESS' },
              }),
            );
            agentHooks.onEnd();
          }
        });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        server,
        profiles,
        requests,
        agentConnections,
        agentFrames,
        agentHooks,
        wss,
      });
    });
  });

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const tempHome = mkdtempSync(path.join(os.tmpdir(), 'browserless-cli-smoke-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.LOCALAPPDATA = path.join(tempHome, 'AppData', 'Local');
delete process.env.BROWSERLESS_TOKEN;
process.env.BROWSERLESS_ACCEPT_TERMS = '1';
// Force file-fallback for token storage. CI runners (especially macOS
// without a UI session) don't have an interactive Keychain — keytar
// loads fine but `setPassword` blocks waiting for user permission.
process.env.BROWSERLESS_DISABLE_KEYCHAIN = '1';

const stub = await startStubServer();
const VALID_TOKEN = 'valid-test-token';

const seedChromeProfile = () => {
  let dir;
  if (process.platform === 'darwin') {
    dir = path.join(
      tempHome,
      'Library',
      'Application Support',
      'Google',
      'Chrome',
    );
  } else if (process.platform === 'win32') {
    dir = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  } else {
    dir = path.join(tempHome, '.config', 'google-chrome');
  }
  mkdirSync(path.join(dir, 'Default'), { recursive: true });
  writeFileSync(path.join(dir, 'Default', 'Preferences'), '{}');
  writeFileSync(
    path.join(dir, 'Local State'),
    JSON.stringify({
      profile: { info_cache: { Default: { name: 'CI Test' } } },
    }),
  );
  return dir;
};

const run = runCli;

const harness = createCheckHarness();
const { check } = harness;

const assertEq = (actual, expected, hint = '') => {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${hint ? ` (${hint})` : ''}`,
    );
  }
};

const assertContains = (haystack, needle) => {
  if (!String(haystack).includes(needle)) {
    throw new Error(
      `expected output to contain ${JSON.stringify(needle)}, got: ${haystack}`,
    );
  }
};

const assertMatches = (haystack, regex) => {
  if (!regex.test(haystack)) {
    throw new Error(`expected output to match ${regex}, got: ${haystack}`);
  }
};

// ---------------------------------------------------------------------------
// Tier A — version + help
// ---------------------------------------------------------------------------

console.log('\n[Tier A] version + help');

await check('--version exits 0 with semver', async () => {
  const r = await run(['--version']);
  assertEq(r.status, 0);
  assertMatches(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

for (const helpArgs of [
  ['--help'],
  ['profile', '--help'],
  ['profile', 'terms', '--help'],
  ['auth', '--help'],
  ['config', '--help'],
  ['agent', '--help'],
  ['profile', 'sources', '--help'],
  ['profile', 'exclude', '--help'],
]) {
  await check(`browserless ${helpArgs.join(' ')} exits 0`, async () => {
    const r = await run(helpArgs);
    assertEq(r.status, 0);
    assertContains(r.stdout, 'Usage:');
    if (helpArgs[0] === 'agent') assertContains(r.stdout, '--cloud-profile');
  });
}

await check('profile terms exits 0 and prints the disclaimer', async () => {
  const r = await run(['profile', 'terms'], {
    env: { BROWSERLESS_TELEMETRY_DEBUG: '1' },
  });
  assertEq(r.status, 0);
  assertEq(r.stderr, '');
  assertContains(
    r.stdout,
    'Heads up — uploading a profile sends authentication state to Browserless',
  );
  assertContains(r.stdout, 'Privacy policy:');
});

// ---------------------------------------------------------------------------
// Tier B — config get/set/unset round-trip
// ---------------------------------------------------------------------------

console.log('\n[Tier B] config');

await check('config get on unset key prints (unset)', async () => {
  const r = await run(['config', 'get', 'server']);
  assertEq(r.status, 0);
  assertContains(r.stdout, '(unset)');
});

await check('config set server <url> succeeds', async () => {
  const r = await run(['config', 'set', 'server', stub.url]);
  assertEq(r.status, 0);
});

await check('config get server reads back the set value', async () => {
  const r = await run(['config', 'get', 'server']);
  assertEq(r.status, 0);
  assertContains(r.stdout, stub.url);
});

await check('config set terms_ttl_days <int> succeeds', async () => {
  const r = await run(['config', 'set', 'terms_ttl_days', '14']);
  assertEq(r.status, 0);
});

await check('config get terms_ttl_days reads back 14', async () => {
  const r = await run(['config', 'get', 'terms_ttl_days']);
  assertEq(r.status, 0);
  assertContains(r.stdout, '14');
});

await check('config unset terms_ttl_days clears it', async () => {
  const r = await run(['config', 'unset', 'terms_ttl_days']);
  assertEq(r.status, 0);
  const r2 = await run(['config', 'get', 'terms_ttl_days']);
  assertContains(r2.stdout, '(unset)');
});

// Region shorthand (--region / config set region). Decouples users from
// having to remember the full production-<code>.browserless.io URLs.
await check('config set region <known> succeeds', async () => {
  const r = await run(['config', 'set', 'region', 'lon']);
  assertEq(r.status, 0);
});

await check('config get region reads back lon', async () => {
  const r = await run(['config', 'get', 'region']);
  assertEq(r.status, 0);
  assertContains(r.stdout, 'lon');
});

await check('config set region <unknown> rejected with exit 2', async () => {
  const r = await run(['config', 'set', 'region', 'zzz']);
  assertEq(r.status, 2);
  assertContains(r.stderr, 'region must be one of');
});

await check(
  'config unset region clears it (restore for later tests)',
  async () => {
    const r = await run(['config', 'unset', 'region']);
    assertEq(r.status, 0);
  },
);

await check('config set <list-key> rejected with exit 2', async () => {
  const r = await run(['config', 'set', 'excluded_domains', 'foo.com']);
  assertEq(r.status, 2, 'should be UsageError');
  assertContains(r.stderr, 'profile exclude');
});

await check('config set <cli-managed-key> rejected with exit 2', async () => {
  const r = await run(['config', 'set', 'token_storage', 'keychain']);
  assertEq(r.status, 2);
  assertContains(r.stderr, 'managed by the CLI');
});

await check('config set unknown-key rejected with exit 2', async () => {
  const r = await run(['config', 'set', 'not-a-key', 'value']);
  assertEq(r.status, 2);
  assertContains(r.stderr, 'Unknown config key');
});

await check('config set server <bad-url> rejected with exit 2', async () => {
  const r = await run(['config', 'set', 'server', 'not a url']);
  assertEq(r.status, 2);
});

// Re-set the stub server URL so subsequent cloud commands resolve to it
await run(['config', 'set', 'server', stub.url]);

// ---------------------------------------------------------------------------
// Tier C — profile exclude round-trip
// ---------------------------------------------------------------------------

console.log('\n[Tier C] profile exclude');

await check('profile exclude list (empty) exits 0', async () => {
  const r = await run(['profile', 'exclude', 'list']);
  assertEq(r.status, 0);
});

await check('profile exclude add example.com succeeds', async () => {
  const r = await run(['profile', 'exclude', 'add', 'example.com']);
  assertEq(r.status, 0);
});

await check('profile exclude add wildcard.com succeeds', async () => {
  const r = await run(['profile', 'exclude', 'add', '*.wildcard.com']);
  assertEq(r.status, 0);
});

await check('profile exclude list contains both', async () => {
  const r = await run(['profile', 'exclude', 'list']);
  assertEq(r.status, 0);
  assertContains(r.stdout, 'example.com');
  assertContains(r.stdout, 'wildcard.com');
});

await check('profile exclude rm example.com succeeds', async () => {
  const r = await run(['profile', 'exclude', 'rm', 'example.com']);
  assertEq(r.status, 0);
});

await check(
  'profile exclude rm <not-in-list> rejected with exit 2',
  async () => {
    const r = await run(['profile', 'exclude', 'rm', 'never-added.com']);
    assertEq(r.status, 2);
  },
);

// ---------------------------------------------------------------------------
// Tier D — profile sources (custom browsers)
// ---------------------------------------------------------------------------

console.log('\n[Tier D] profile sources');

await check('profile sources add registers a custom browser', async () => {
  const r = await run([
    'profile',
    'sources',
    'add',
    '--name',
    'my-custom',
    '--path',
    process.execPath,
    '--user-data-dir',
    tempHome,
  ]);
  assertEq(r.status, 0);
  assertContains(r.stdout, 'Registered');
});

await check(
  'profile sources add <duplicate> rejected with exit 2',
  async () => {
    const r = await run([
      'profile',
      'sources',
      'add',
      '--name',
      'my-custom',
      '--path',
      process.execPath,
      '--user-data-dir',
      tempHome,
    ]);
    assertEq(r.status, 2);
  },
);

await check(
  'profile sources add <built-in name> rejected with exit 2',
  async () => {
    const r = await run([
      'profile',
      'sources',
      'add',
      '--name',
      'chrome',
      '--path',
      process.execPath,
      '--user-data-dir',
      tempHome,
    ]);
    assertEq(r.status, 2);
    assertContains(r.stderr, 'collides');
  },
);

await check('profile sources add rejects a non-existent --path', async () => {
  const r = await run([
    'profile',
    'sources',
    'add',
    '--name',
    'bogus-bin',
    '--path',
    path.join(tempHome, 'does-not-exist'),
    '--user-data-dir',
    tempHome,
  ]);
  assertEq(r.status, 2);
  assertContains(r.stderr, '--path does not exist');
});

await check(
  'profile sources add rejects a non-existent --user-data-dir',
  async () => {
    const r = await run([
      'profile',
      'sources',
      'add',
      '--name',
      'bogus-dir',
      '--path',
      process.execPath,
      '--user-data-dir',
      path.join(tempHome, 'does-not-exist'),
    ]);
    assertEq(r.status, 2);
    assertContains(r.stderr, '--user-data-dir does not exist');
  },
);

await check(
  'profile sources add rejects --path pointing at a directory',
  async () => {
    const r = await run([
      'profile',
      'sources',
      'add',
      '--name',
      'bogus-shape',
      '--path',
      tempHome, // dir, not a binary
      '--user-data-dir',
      tempHome,
    ]);
    assertEq(r.status, 2);
    assertContains(r.stderr, '--path must point at a binary');
  },
);

await check('profile sources rm my-custom succeeds', async () => {
  const r = await run(['profile', 'sources', 'rm', 'my-custom']);
  assertEq(r.status, 0);
});

await check('profile sources rm <unknown> rejected with exit 2', async () => {
  const r = await run(['profile', 'sources', 'rm', 'not-registered']);
  assertEq(r.status, 2);
});

// Broken-entry surfacing: register a custom against real fixture paths,
// then nuke one of them, and assert `sources list --json` reports it
// under `brokenCustoms` rather than silently filtering. Without this
// signal the registration sits forever in custom-browsers.json and the
// user has no way to discover the entry is dead short of running
// `sources rm <every-name>` blindly.
await check(
  'profile sources list surfaces broken registrations under brokenCustoms',
  async () => {
    const fakeBin = path.join(tempHome, 'fake-bin');
    const fakeDataDir = path.join(tempHome, 'fake-data-dir');
    writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    mkdirSync(fakeDataDir, { recursive: true });

    const add = await run([
      'profile',
      'sources',
      'add',
      '--name',
      'broken-soon',
      '--path',
      fakeBin,
      '--user-data-dir',
      fakeDataDir,
    ]);
    assertEq(add.status, 0);

    // Simulate post-registration removal (e.g. apt upgrade moved the binary)
    rmSync(fakeBin);

    const r = await run(['profile', 'sources', 'list', '--json']);
    assertEq(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    const broken = parsed.brokenCustoms.find((b) => b.name === 'broken-soon');
    if (!broken) {
      throw new Error(
        `expected broken-soon in brokenCustoms; got: ${JSON.stringify(parsed.brokenCustoms)}`,
      );
    }
    assertEq(broken.missingBinary, true);
    assertEq(broken.missingUserDataDir, false);

    // Clean up so subsequent tests see a stable registry
    await run(['profile', 'sources', 'rm', 'broken-soon']);
    rmSync(fakeDataDir, { recursive: true, force: true });
  },
);

// ---------------------------------------------------------------------------
// Tier E — profile sources list (with seeded user-data-dir)
// ---------------------------------------------------------------------------

console.log('\n[Tier E] profile sources list (discovery)');

const seededDir = seedChromeProfile();

await check('profile sources list (text) finds the seeded Chrome', async () => {
  const r = await run(['profile', 'sources', 'list']);
  assertEq(
    r.status,
    0,
    `stderr: ${r.stderr.trim()} | stdout: ${r.stdout.trim()}`,
  );
  assertContains(r.stdout, 'Google Chrome');
});

await check(
  'profile sources list --json includes chrome with the right path',
  async () => {
    const r = await run(['profile', 'sources', 'list', '--json']);
    assertEq(
      r.status,
      0,
      `stderr: ${r.stderr.trim()} | stdout: ${r.stdout.trim()}`,
    );
    const parsed = JSON.parse(r.stdout);
    if (!parsed || !Array.isArray(parsed.profiles)) {
      throw new Error(
        `expected { profiles, brokenCustoms } object, got: ${r.stdout}`,
      );
    }
    if (!Array.isArray(parsed.brokenCustoms)) {
      throw new Error(`expected brokenCustoms array, got: ${r.stdout}`);
    }
    const chrome = parsed.profiles.find((s) => s.browserKey === 'chrome');
    if (!chrome)
      throw new Error(`chrome not in: ${JSON.stringify(parsed.profiles)}`);
    assertEq(chrome.userDataDir, seededDir);
  },
);

// ---------------------------------------------------------------------------
// Tier F — auth login / status / logout (against stub server)
// ---------------------------------------------------------------------------

console.log('\n[Tier F] auth (against stub server)');

await check('auth status before login reports no token', async () => {
  const r = await run(['auth', 'status']);
  assertEq(r.status, 0);
  assertContains(r.stdout, 'token storage:');
});

await check('auth login (invalid token) rejected with exit 3', async () => {
  const r = await run(['auth', 'login', 'invalid-token']);
  assertEq(r.status, 3);
  assertContains(r.stderr, 'rejected');
});

await check(
  'auth login (valid token) persists + reports keychain or file',
  async () => {
    const r = await run(['auth', 'login', VALID_TOKEN]);
    assertEq(r.status, 0);
    assertContains(r.stdout, 'Token saved');
  },
);

await check('auth status after login reports valid token', async () => {
  const r = await run(['auth', 'status']);
  assertEq(r.status, 0);
  assertContains(r.stdout, 'token check:');
});

// Pipe-stdin path: `echo $TOKEN | browserless auth login` — exercises the
// readFromStdin branch in src/commands/auth/login.ts. Real-world usage
// pattern for env-var / shell-pipeline auth.
await check('auth login (no arg) reads token from piped stdin', async () => {
  // Clear out the previously-set token so we know the pipe path wrote it
  await run(['auth', 'logout']);
  const r = await run(['auth', 'login'], { stdin: `${VALID_TOKEN}\n` });
  assertEq(r.status, 0);
  assertContains(r.stdout, 'Token saved');
  // Verify it actually persisted
  const status = await run(['auth', 'status']);
  assertEq(status.status, 0);
  assertContains(status.stdout, 'token check:');
});

// ---------------------------------------------------------------------------
// Tier G — profile list / show / rename / delete (against stub)
// ---------------------------------------------------------------------------

console.log('\n[Tier G] profile cloud commands (against stub)');

await check('profile list (text)', async () => {
  const r = await run(['profile', 'list']);
  assertEq(r.status, 0);
  assertContains(r.stdout, 'demo-profile');
});

await check('profile list --json', async () => {
  const r = await run(['profile', 'list', '--json']);
  assertEq(r.status, 0);
  const list = JSON.parse(r.stdout);
  if (!Array.isArray(list)) throw new Error('expected array');
});

// ---------------------------------------------------------------------------
// Tier G2 — profile list pagination (--limit / --offset)
// ---------------------------------------------------------------------------

console.log('\n[Tier G2] profile list pagination');

// Seed enough extras that a 2-page slice exercises both limit and offset.
// Names chosen to sort predictably (the stub sorts /profiles by name) so
// we can assert the exact contents of each page. demo-profile is already
// in the seed; we leave it alone so the rename/delete tests below still
// have something to operate on, and clean up the seeded extras after.
const paginationSeed = ['page-a', 'page-b', 'page-c', 'page-d'];
for (const name of paginationSeed) {
  stub.profiles[name] = {
    id: `profile_${name}`,
    name,
    cookieCount: 0,
    originCount: 0,
    lastUsedAt: null,
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  };
}

// Sorted order across all 5 seeded profiles: demo-profile, page-a, page-b,
// page-c, page-d. With --limit 2 --offset 1 we expect [page-a, page-b].

await check(
  'profile list --limit 2 --json returns exactly 2 entries',
  async () => {
    const r = await run(['profile', 'list', '--limit', '2', '--json']);
    assertEq(r.status, 0);
    const list = JSON.parse(r.stdout);
    assertEq(list.length, 2, `got ${list.length}`);
    assertEq(list[0].name, 'demo-profile');
    assertEq(list[1].name, 'page-a');
  },
);

await check(
  'profile list --limit 2 --offset 2 --json returns the next page',
  async () => {
    const r = await run([
      'profile',
      'list',
      '--limit',
      '2',
      '--offset',
      '2',
      '--json',
    ]);
    assertEq(r.status, 0);
    const list = JSON.parse(r.stdout);
    assertEq(list.length, 2, `got ${list.length}`);
    assertEq(list[0].name, 'page-b');
    assertEq(list[1].name, 'page-c');
  },
);

await check('profile list --offset past end returns empty array', async () => {
  const r = await run(['profile', 'list', '--offset', '100', '--json']);
  assertEq(r.status, 0);
  const list = JSON.parse(r.stdout);
  assertEq(list.length, 0);
});

await check(
  'profile list --limit 0 rejected with exit 2 (positive int required)',
  async () => {
    const r = await run(['profile', 'list', '--limit', '0']);
    assertEq(r.status, 2);
    assertContains(r.stderr, '--limit');
  },
);

await check(
  'profile list --limit abc rejected with exit 2 (decimal-only)',
  async () => {
    const r = await run(['profile', 'list', '--limit', 'abc']);
    assertEq(r.status, 2);
    assertContains(r.stderr, '--limit');
  },
);

await check('profile list --offset -1 rejected with exit 2', async () => {
  const r = await run(['profile', 'list', '--offset', '-1']);
  assertEq(r.status, 2);
  assertContains(r.stderr, '--offset');
});

// Clean up the seeded extras so the rename/delete tests below still see
// the original single demo-profile world.
for (const name of paginationSeed) delete stub.profiles[name];

await check('profile show demo-profile', async () => {
  const r = await run(['profile', 'show', 'demo-profile']);
  assertEq(r.status, 0);
  assertContains(r.stdout, 'demo-profile');
});

await check('profile show <missing> exits 5 (404)', async () => {
  const r = await run(['profile', 'show', 'does-not-exist']);
  assertEq(r.status, 5);
});

await check('profile rename demo-profile → demo-renamed', async () => {
  const r = await run(['profile', 'rename', 'demo-profile', 'demo-renamed']);
  assertEq(r.status, 0);
});

await check('profile show demo-renamed (after rename)', async () => {
  const r = await run(['profile', 'show', 'demo-renamed']);
  assertEq(r.status, 0);
});

await check('profile delete demo-renamed', async () => {
  const r = await run(['profile', 'delete', 'demo-renamed']);
  assertEq(r.status, 0);
});

await check('profile show demo-renamed (after delete) exits 5', async () => {
  const r = await run(['profile', 'show', 'demo-renamed']);
  assertEq(r.status, 5);
});

await check('auth logout clears credentials', async () => {
  const r = await run(['auth', 'logout']);
  assertEq(r.status, 0);
});

// ---------------------------------------------------------------------------
// Hosted agent — no real cloud requests or browser sessions.
// ---------------------------------------------------------------------------

const agentArgs = [
  '--server',
  stub.url,
  '--token',
  VALID_TOKEN,
  '--no-history',
];
stub.profiles.work = {
  id: 'profile_work',
  name: 'work',
  cookieCount: 1,
  originCount: 0,
};

await check(
  'agent missing cloud profile exits 2 before WebSocket upgrade',
  async () => {
    const r = await run([
      'agent',
      'list my PRs',
      '--cloud-profile',
      'missing',
      '--json',
      ...agentArgs,
    ]);
    assertEq(r.status, 2, r.stderr);
    assertContains(r.stderr, 'browserless profile list');
    assertEq(stub.agentConnections.length, 0);
  },
);

await check(
  'agent malformed cloud profile exits 2 before any request',
  async () => {
    const before = stub.requests.length;
    const r = await run([
      'agent',
      'list my PRs',
      '--cloud-profile',
      'a b',
      ...agentArgs,
    ]);
    assertEq(r.status, 2, r.stderr);
    assertEq(stub.requests.length, before);
    assertEq(stub.agentConnections.length, 0);
  },
);

for (const cloudProfile of ['work', undefined]) {
  await check(
    `agent JSON login task without credential prompts (profile=${cloudProfile})`,
    async () => {
      const prompt = 'Log in to example.com and open settings';
      const before = stub.agentFrames.length;
      const r = await run(
        [
          'agent',
          prompt,
          '--json',
          ...(cloudProfile ? ['--cloud-profile', cloudProfile] : []),
          ...agentArgs,
        ],
        {
          timeoutMs: 15000,
          onChild(child) {
            stub.agentHooks.onEnd = () => {
              // Wait for the result to reach the REPL before sending its exit line.
              child.stdout.once('data', () => child.stdin.end('\n'));
            };
          },
        },
      );
      assertEq(r.status, 0, r.stderr);
      const frames = stub.agentFrames.slice(before);
      assertEq(frames.length, 1);
      assertEq(frames[0].type, 'start');
      assertContains(frames[0].prompt, `User task:\n${prompt}`);
      assertContains(frames[0].prompt, 'Never ask the user for a password');
      assertContains(
        frames[0].prompt,
        'You may still ask the user for a one-time verification code',
      );
      assertEq(/USERNAME=|PASSWORD=/.test(frames[0].prompt), false);
      assertEq(JSON.parse(r.stdout).result.success, true);
      assertEq(r.stderr.includes('Username'), false);
      if (cloudProfile) {
        assertContains(
          frames[0].prompt,
          'pass "profile": "work" to browserless_agent',
        );
        assertEq(r.stderr.includes('Tip:'), false);
      } else {
        assertContains(r.stderr, "Tip: the agent can't sign in for you.");
        assertContains(r.stderr, 'browserless profile upload --name <name>');
        assertContains(r.stderr, 'browserless agent --cloud-profile <name>');
      }
    },
  );
}

stub.wss.close();
stub.server.close();
rmSync(tempHome, { recursive: true, force: true });

harness.printSummary();
