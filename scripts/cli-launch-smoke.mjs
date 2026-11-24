#!/usr/bin/env node
/**
 * Real-Chrome `profile launch` smoke test.
 *
 * Covers the OS-divergent code paths that capture-smoke doesn't reach:
 *   - profile launch --headless --json prints valid JSON + CDP comes up
 *   - Killing the CLI process terminates Chrome (no orphan processes left)
 *   - Lock detection: if Chrome is already running against the
 *     user-data-dir, the CLI refuses with exit 3
 *
 * These are the failure modes that bite real Windows / Linux installs.
 *
 * Run after `npm link`:
 *   $ npm run build && npm link && node scripts/cli-launch-smoke.mjs
 *
 * Exits non-zero on any failed assertion.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { runCli, spawnLaunch } from './lib/run-cli.mjs';
import { createCheckHarness } from './lib/check.mjs';
import { detectChromeBinary } from './lib/detect-chrome.mjs';
import { setupSmokeEnv } from './lib/setup.mjs';

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

// ---------------------------------------------------------------------------
// Setup — see cli-capture-smoke for why we avoid $HOME overrides.
// ---------------------------------------------------------------------------

const { tempRoot } = setupSmokeEnv({
  prefix: 'browserless-cli-launch-',
  cdpWaitMs: 60_000,
});
const fakeUserDataDir = path.join(tempRoot, 'chrome-user-data');

const chromeBin = detectChromeBinary();
if (!chromeBin) {
  console.error(`No Chrome binary found on ${process.platform}.`);
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

const BROWSER_KEY = 'cli-launch-chrome';

const oneShot = (args, opts) => runCli(args, { timeoutMs: 90_000, ...opts });

// List Chrome PIDs whose command line includes a given user-data-dir.
// Used to verify cleanup left no orphan Chrome processes.
const chromePidsForDir = (dir) => {
  if (process.platform === 'win32') {
    // WMIC is deprecated; CIM is the modern path. Get-CimInstance is
    // available on every Windows runner we support.
    const out = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${dir.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessId`,
    ]);
    return out.stdout
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  }
  const out = spawnSync('pgrep', ['-f', dir]);
  return out.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(Number);
};

const killProcess = (pid) => {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)]);
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
};

// Wait for all chrome processes matching `dir` to actually disappear
// (not just be SIGKILLed). On POSIX, `kill(pid, 0)` on a zombie returns
// success until init reaps it — so between SIGKILL and reap, the lock
// check sees the pid as alive and refuses with exit 3. Poll until clear.
const waitForChromeReaped = async (dir, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chromePidsForDir(dir).length === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
};

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const harness = createCheckHarness();
const { check } = harness;

// Register the custom browser source for both built-in flows
const setupPromise = (async () => {
  await oneShot(['config', 'set', 'server', 'http://127.0.0.1:1']); // unused
  await oneShot(['auth', 'login', 'launch-smoke-token']);
  const r = await oneShot([
    'profile', 'sources', 'add',
    '--name', BROWSER_KEY,
    '--path', chromeBin,
    '--user-data-dir', fakeUserDataDir,
  ]);
  if (r.status !== 0) {
    throw new Error(`Failed to register custom browser source: ${r.stderr}`);
  }
})();
await setupPromise;

// ---------------------------------------------------------------------------
// Test: profile launch happy path
// ---------------------------------------------------------------------------

console.log('\n[Launch] profile launch lifecycle');

await check('profile launch --headless --json prints valid JSON with CDP endpoint', async () => {
  const { parsed, child, stderr } = await spawnLaunch(
    [
      'profile', 'launch',
      '--browser', BROWSER_KEY,
      '--profile', 'Default',
      '--headless',
      '--json',
    ],
    { timeoutMs: 90_000 },
  );
  try {
    if (typeof parsed.pid !== 'number') {
      throw new Error(`pid missing/wrong type: ${JSON.stringify(parsed)}`);
    }
    if (typeof parsed.webSocketDebuggerUrl !== 'string' || !parsed.webSocketDebuggerUrl.startsWith('ws://')) {
      throw new Error(`webSocketDebuggerUrl missing: ${JSON.stringify(parsed)}`);
    }
    // Validate the advertised CDP endpoint actually responds.
    const httpEndpoint = parsed.httpEndpoint;
    if (!httpEndpoint) throw new Error('httpEndpoint missing from JSON');
    const res = await fetch(`${httpEndpoint}/json/version`);
    if (!res.ok) throw new Error(`CDP /json/version returned ${res.status}`);
    const body = await res.json();
    if (!body.Browser) throw new Error(`CDP body missing Browser field: ${JSON.stringify(body)}`);
  } finally {
    // Cleanup for the next test — kill the CLI hard so we know the next
    // test starts fresh. We test CLEAN shutdown in the next test.
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    await new Promise((r) => child.once('exit', r));
    // Reap any straggling Chrome AND wait for them to actually disappear
    // before the next test starts — checkProfileLock reads kill(pid, 0)
    // and a zombie still reports alive, causing the next test to refuse
    // with exit 3 (PreconditionError) before it can even boot Chrome.
    for (const pid of chromePidsForDir(fakeUserDataDir)) killProcess(pid);
    await waitForChromeReaped(fakeUserDataDir);
    void stderr;
  }
});

// ---------------------------------------------------------------------------
// Test: killing the CLI leaves no orphan Chrome processes
//
// POSIX only. On Windows, Chrome's renderer/utility processes use
// CREATE_BREAKAWAY_FROM_JOB and can briefly survive `taskkill /T /F` —
// they self-exit within ~30s when their IPC pipes detect the parent's
// death. Real users don't hit this (Ctrl-C → SIGINT handler works fine,
// covered by the lock + concurrent tests below); the only path here is
// external force-kill via Task Manager, which isn't worth gating CI on.
// ---------------------------------------------------------------------------

if (process.platform !== 'win32') await check('killing the CLI terminates Chrome (no orphans)', async () => {
  const { parsed, child } = await spawnLaunch(
    [
      'profile', 'launch',
      '--browser', BROWSER_KEY,
      '--profile', 'Default',
      '--headless',
      '--json',
    ],
    { timeoutMs: 90_000 },
  );
  const chromePid = parsed.pid;

  // Sanity-check: Chrome is actually running
  const beforePids = chromePidsForDir(fakeUserDataDir);
  if (!beforePids.includes(chromePid)) {
    console.log(`    note: Chrome pid ${chromePid} not in pre-kill scan: ${JSON.stringify(beforePids)}`);
  }

  child.kill('SIGINT');
  // Wait for CLI exit (bounded — escalate to SIGKILL if it sticks)
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });

  // Poll for orphans. SIGTERM → SIGKILL with stdio close in killBrowser
  // typically reaps Chrome in <1 s on POSIX; 5 s is plenty of slack.
  let remaining = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    remaining = chromePidsForDir(fakeUserDataDir);
    if (remaining.length === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (remaining.length > 0) {
    for (const pid of remaining) killProcess(pid);
    throw new Error(
      `orphan Chrome processes remain after CLI kill: ${JSON.stringify(remaining)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test: locked-profile refusal
// ---------------------------------------------------------------------------

console.log('\n[Launch] locked-profile refusal');

await check('profile launch refuses when Chrome already running (exit 3)', async () => {
  // Boot Chrome A with --remote-debugging-port so we can prove it's
  // actually alive (CDP responds) before running the CLI. Just polling
  // for SingletonLock to appear isn't enough — Chrome A can briefly
  // create the lock then die, leaving a STALE lock pointing at a dead
  // pid; the CLI then sees not-locked and tries to boot its own Chrome,
  // racing into a 30 s timeout.
  const chromeAPort = await pickFreePort();
  const chromeA = spawn(chromeBin, [
    `--user-data-dir=${fakeUserDataDir}`,
    `--remote-debugging-port=${chromeAPort}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeAStderr = '';
  chromeA.stdout.on('data', () => {});
  chromeA.stderr.on('data', (d) => {
    chromeAStderr += d.toString();
  });

  try {
    // Wait for Chrome A's CDP to come up — proves it's truly running.
    const deadline = Date.now() + 30_000;
    let cdpUp = false;
    while (Date.now() < deadline) {
      if (chromeA.exitCode !== null || chromeA.signalCode !== null) {
        throw new Error(
          `Chrome A exited before CDP came up (code=${chromeA.exitCode}, signal=${chromeA.signalCode}). stderr: ${chromeAStderr.slice(-500)}`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${chromeAPort}/json/version`);
        if (res.ok) {
          cdpUp = true;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!cdpUp) {
      throw new Error(
        `Chrome A's CDP never came up on port ${chromeAPort} within 30s. stderr: ${chromeAStderr.slice(-500)}`,
      );
    }

    const r = await oneShot(
      [
        'profile', 'launch',
        '--browser', BROWSER_KEY,
        '--profile', 'Default',
        '--headless',
        '--json',
      ],
      { timeoutMs: 30_000 },
    );
    if (r.status !== 3) {
      throw new Error(
        `expected exit 3 (PreconditionError), got ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );
    }
    if (!/already running|locked|in use/i.test(r.stderr)) {
      throw new Error(
        `stderr did not mention lock state: ${r.stderr.slice(0, 300)}`,
      );
    }
  } finally {
    try {
      chromeA.kill('SIGKILL');
    } catch {
      // already gone
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3_000);
      chromeA.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    for (const pid of chromePidsForDir(fakeUserDataDir)) killProcess(pid);
    await waitForChromeReaped(fakeUserDataDir);
  }
});

// ---------------------------------------------------------------------------
// Test: concurrent profile launch invocations
//
// The first invocation boots Chrome (which writes the OS-appropriate lock
// file). A second invocation against the same user-data-dir should hit
// the same lock-refusal path as a manually-launched Chrome would, with
// exit 3.
// ---------------------------------------------------------------------------

console.log('\n[Launch] concurrent invocations');

await check('second concurrent profile launch is refused (exit 3)', async () => {
  const { child: firstChild, parsed } = await spawnLaunch(
    [
      'profile', 'launch',
      '--browser', BROWSER_KEY,
      '--profile', 'Default',
      '--headless',
      '--json',
    ],
    { timeoutMs: 90_000 },
  );
  try {
    // Sanity-check that Chrome A is alive
    if (typeof parsed.pid !== 'number') {
      throw new Error('first launch did not report a Chrome PID');
    }

    // Second invocation should immediately hit the lock and refuse
    const r = await oneShot(
      [
        'profile', 'launch',
        '--browser', BROWSER_KEY,
        '--profile', 'Default',
        '--headless',
        '--json',
      ],
      { timeoutMs: 30_000 },
    );
    if (r.status !== 3) {
      throw new Error(
        `expected exit 3 (PreconditionError), got ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`,
      );
    }
    if (!/already running|locked|in use/i.test(r.stderr)) {
      throw new Error(`stderr did not mention lock state: ${r.stderr.slice(0, 300)}`);
    }
  } finally {
    try {
      firstChild.kill('SIGKILL');
    } catch {
      // already gone
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3_000);
      firstChild.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    for (const pid of chromePidsForDir(fakeUserDataDir)) killProcess(pid);
    await waitForChromeReaped(fakeUserDataDir);
  }
});

// ---------------------------------------------------------------------------
// Cleanup + report
// ---------------------------------------------------------------------------

// Make sure no Chrome lingers regardless of test outcome
for (const pid of chromePidsForDir(fakeUserDataDir)) killProcess(pid);
rmSync(tempRoot, { recursive: true, force: true });

harness.printSummary();
