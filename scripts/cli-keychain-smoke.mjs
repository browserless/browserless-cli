#!/usr/bin/env node
/**
 * Real-keychain smoke test.
 *
 * The main cli-smoke forces `BROWSERLESS_DISABLE_KEYCHAIN=1` to exercise
 * the file-fallback path deterministically on every runner. This script
 * does the opposite: enables keytar and verifies the OS credential store
 * round-trips an auth token end-to-end.
 *
 *   - Windows: Credential Manager (DPAPI) — works out-of-the-box
 *   - Linux:   gnome-keyring via libsecret — requires the CI workflow to
 *              start gnome-keyring-daemon under a D-Bus session
 *   - macOS:   Keychain Services — needs unlocked default keychain; the
 *              hosted runner blocks on permission prompts, so this script
 *              is skipped on darwin in CI
 *
 * Run after `npm link`:
 *   $ npm run build && npm link && node scripts/cli-keychain-smoke.mjs
 */
import http from 'node:http';
import { runCli } from './lib/run-cli.mjs';
import { createCheckHarness } from './lib/check.mjs';
import { setupSmokeEnv } from './lib/setup.mjs';

// macOS in CI requires a pre-unlocked throwaway keychain — set up in the
// `Set up throwaway macOS Keychain` step of ci.yml via `security
// create-keychain` + `unlock-keychain` + `default-keychain`. Without that
// step the runner blocks on a permission dialog.

// disableKeychain: false is the whole point — this script verifies the
// real OS credential store round-trips a token end-to-end.
const { cleanup: cleanupTempRoot } = setupSmokeEnv({
  prefix: 'browserless-cli-keychain-',
  disableKeychain: false,
});

const TEST_TOKEN = `keychain-smoke-${Date.now()}`;

// Tiny stub server: auth login validates the token by hitting /profiles.
// 200 = token valid; everything else = invalid.
const startStub = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('token') === TEST_TOKEN) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Invalid token' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });

const stub = await startStub();
const TEST_SERVER = stub.url;

const run = (args, opts) => runCli(args, { timeoutMs: 30_000, ...opts });

const harness = createCheckHarness();
const { check } = harness;

console.log(`Platform: ${process.platform}`);
console.log(`Server: ${TEST_SERVER}`);

await run(['config', 'set', 'server', TEST_SERVER]);

let usedKeychain = false;

await check('auth login (valid token) reports keychain backend', async () => {
  const r = await run(['auth', 'login', TEST_TOKEN]);
  if (r.status !== 0) {
    throw new Error(`exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
  }
  // The CLI prints either "saved to keychain" or "saved to file" depending
  // on the runtime detection. With keychain enabled, we expect "keychain".
  if (/keychain/i.test(r.stdout)) {
    usedKeychain = true;
  } else if (/file/i.test(r.stdout)) {
    throw new Error(
      `Keychain was expected to be used but CLI fell back to file storage.\n` +
        `stdout: ${r.stdout.trim()}\nstderr: ${r.stderr.trim()}\n` +
        `Did the CI setup step start a credential service for this platform?`,
    );
  } else {
    throw new Error(`Could not infer storage backend from output:\n${r.stdout}`);
  }
});

await check('auth status reads token back from the keychain', async () => {
  if (!usedKeychain) throw new Error('skipped — login did not use keychain');
  const r = await run(['auth', 'status']);
  if (r.status !== 0) {
    throw new Error(`exit ${r.status}\nstderr: ${r.stderr}`);
  }
  if (!/logged in|authenticated|valid/i.test(r.stdout)) {
    throw new Error(`auth status did not report logged-in state:\n${r.stdout}`);
  }
});

await check('auth logout removes the entry from the keychain', async () => {
  if (!usedKeychain) throw new Error('skipped — login did not use keychain');
  const r = await run(['auth', 'logout']);
  if (r.status !== 0) {
    throw new Error(`exit ${r.status}\nstderr: ${r.stderr}`);
  }
  const status = await run(['auth', 'status']);
  if (/logged in|authenticated/i.test(status.stdout)) {
    throw new Error(`auth status after logout still reports logged-in:\n${status.stdout}`);
  }
});

// Defensive cleanup — even if assertions fail, make sure we don't leave
// a stray credential entry on the runner (matters less for ephemeral CI
// VMs but matters a lot when running locally).
await run(['auth', 'logout']);
stub.server.close();
cleanupTempRoot();

harness.printSummary();
