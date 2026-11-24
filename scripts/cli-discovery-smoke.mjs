#!/usr/bin/env node
/**
 * Real built-in browser discovery smoke test.
 *
 * `cli-capture-smoke` exercises the capture pipeline via a registered
 * *custom* browser source pointing at the runner's real Chrome. This
 * script exercises the BUILT-IN registry path — installing Brave / Edge,
 * seeding their canonical user-data-dirs at the OS-standard location,
 * and running `profile inspect` against `--browser brave` / `--browser
 * edge` so the registry's userDataDirByPlatform paths are exercised
 * end-to-end. Catches regressions in the registry path definitions, the
 * binary-path discovery, and per-browser launch quirks.
 *
 * Skipped on macOS (real installs of Chrome variants hit the same
 * Launch Services / XPC handshake issue that bit us in cli-capture-smoke).
 * macOS coverage for the registry remains the unit tests + manual smoke
 * workflows.
 *
 * Run after the CI workflow installs Brave (and on non-Windows, Edge):
 *   $ node scripts/cli-discovery-smoke.mjs
 */
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { runCli } from './lib/run-cli.mjs';
import { createCheckHarness } from './lib/check.mjs';
import { setupSmokeEnv } from './lib/setup.mjs';
import path from 'node:path';

if (process.platform === 'darwin') {
  console.log('Skipping discovery smoke on macOS — hosted runner Chrome-variant headless mode is unreliable.');
  process.exit(0);
}

// Each entry: which built-in browser to exercise on this OS. `userDataDirs`
// is a list because some browsers install into different locations under
// different package managers (e.g. Chromium: apt vs Snap). The test picks
// the first candidate whose parent dir is accessible — usually corresponds
// 1:1 to which binaryCandidate was found.
const targetsByPlatform = {
  linux: [
    {
      key: 'brave',
      binaryCandidates: ['/usr/bin/brave-browser', '/usr/bin/brave-browser-stable'],
      userDataDirs: [path.join(os.homedir(), '.config', 'BraveSoftware', 'Brave-Browser')],
    },
    {
      key: 'edge',
      binaryCandidates: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
      userDataDirs: [path.join(os.homedir(), '.config', 'microsoft-edge')],
    },
    {
      // Chromium has two install styles on Linux:
      //   apt:  /usr/bin/chromium      → ~/.config/chromium
      //   Snap: /snap/bin/chromium     → ~/snap/chromium/common/chromium
      // The full `profile inspect` flow against Snap-installed chromium
      // currently fails because Snap confinement blocks the capture
      // pipeline's temp user-data-dir copy at /tmp/... — that's a real
      // CLI limitation to fix later. For now we exercise only the
      // *discovery* half: that `profile sources list` finds chromium
      // with the expected paths. Skips automatically when no chromium
      // binary is installed.
      key: 'chromium',
      mode: 'lookup-only',
      binaryCandidates: [
        '/snap/bin/chromium',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ],
      userDataDirs: [
        path.join(os.homedir(), 'snap', 'chromium', 'common', 'chromium'),
        path.join(os.homedir(), '.config', 'chromium'),
      ],
    },
  ],
  win32: [
    {
      key: 'brave',
      binaryCandidates: [
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        // Per-user install (what `choco install brave` produces on the CI
        // runner; also default for users who don't run the installer as
        // Administrator).
        path.join(
          process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
          'BraveSoftware',
          'Brave-Browser',
          'Application',
          'brave.exe',
        ),
      ],
      userDataDirs: [path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
        'BraveSoftware',
        'Brave-Browser',
        'User Data',
      )],
    },
    {
      key: 'edge',
      binaryCandidates: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
      userDataDirs: [path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
        'Microsoft',
        'Edge',
        'User Data',
      )],
    },
  ],
};

const targets = targetsByPlatform[process.platform] ?? [];
if (targets.length === 0) {
  console.log(`No discovery targets defined for ${process.platform}.`);
  process.exit(0);
}

const { cleanup: cleanupTempRoot } = setupSmokeEnv({
  prefix: 'browserless-cli-discovery-',
  cdpWaitMs: 60_000,
});

const run = (args, opts) => runCli(args, { timeoutMs: 90_000, ...opts });

// A profile copy that races a transient Windows file lock surfaces as a
// CaptureError (exit 4) with EPERM/EBUSY/"Permission denied" on stderr —
// e.g. a Brave background process from the fresh install briefly holding a
// file in User Data. Retry exactly once on that signature; anything else
// propagates as a real failure. Counted across the suite so the CI run can
// fail if the flake is degrading further (>1 retry per suite means
// something has changed).
const MAX_TOTAL_RETRIES = 1;
let totalRetries = 0;
const isTransientCopyLock = (r) =>
  r.status !== 0 && /EPERM|EBUSY|permission denied/i.test(r.stderr);
const runWithCaptureRetry = async (args, opts = {}) => {
  const first = await run(args, opts);
  if (!isTransientCopyLock(first)) return first;
  totalRetries++;
  const firstStderr = first.stderr.trim().split('\n').slice(-10).join('\n');
  console.log(
    `    [flake] transient EPERM/EBUSY during profile copy (retry ${totalRetries}/${MAX_TOTAL_RETRIES + 1}). First-attempt stderr (last 10 lines):\n    ${firstStderr.split('\n').join('\n    ')}`,
  );
  if (totalRetries > MAX_TOTAL_RETRIES) {
    throw new Error(
      `Too many capture retries (${totalRetries}) — the workaround is masking a real regression. Investigate before re-running.`,
    );
  }
  // Brief pause so a transiently-locked Windows file can be released before
  // the retry re-copies the profile.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return run(args, opts);
};

const harness = createCheckHarness();
const { check, skip } = harness;

const seedUserDataDir = (dir) => {
  // Start from a clean slate so `profile inspect` copies only this minimal
  // profile, not whatever the real install left behind. On Windows a Brave
  // background/updater process from the fresh choco install can hold a lock
  // on one of its own files in User Data, which EPERMs the capture copy
  // (fs.cp aborts on the first unreadable entry). Best-effort — a file that
  // is still transiently locked is covered by the inspect retry below.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // locked entry — leave it; runWithCaptureRetry handles the transient case
  }
  mkdirSync(path.join(dir, 'Default'), { recursive: true });
  writeFileSync(path.join(dir, 'Default', 'Preferences'), '{}');
  writeFileSync(
    path.join(dir, 'Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: 'CI Test' } } } }),
  );
};

console.log(`Platform: ${process.platform}`);

// Pick the user-data-dir candidate matching whatever install style is
// actually present. We use parent-dir existence as the heuristic — e.g.
// `~/snap/chromium/common` exists iff Snap chromium is installed, and
// `~/.config` exists for apt-style installs. First match wins.
const pickUserDataDir = (candidates) => {
  for (const dir of candidates) {
    if (existsSync(path.dirname(dir))) return dir;
  }
  return candidates[0];
};

for (const target of targets) {
  const binary = target.binaryCandidates.find((p) => existsSync(p));
  const userDataDir = pickUserDataDir(target.userDataDirs);
  console.log(`\n[Discovery] ${target.key} (binary: ${binary ?? 'NOT FOUND'}, user-data-dir: ${userDataDir})`);

  if (target.mode === 'lookup-only') {
    // Registry lookup only — useful for browsers whose capture pipeline
    // we can't run end-to-end on CI (e.g. Snap-confined Chromium). We
    // seed the user-data-dir so the registry's existence check passes,
    // then run `profile sources list --json` and assert the entry shows
    // up with the right paths.
    await check(`profile sources list --json finds ${target.key}`, async () => {
      if (!binary) {
        skip(`${target.key} not installed at any expected path — CI step missed?`);
      }
      seedUserDataDir(userDataDir);

      try {
        const r = await run(
          ['profile', 'sources', 'list', '--json'],
          { timeoutMs: 30_000 },
        );
        if (r.status !== 0) {
          throw new Error(
            `exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout.slice(0, 500)}`,
          );
        }
        const parsed = JSON.parse(r.stdout);
        const sources = parsed.profiles;
        if (!Array.isArray(sources)) {
          throw new Error(
            `expected { profiles, brokenCustoms } object, got: ${r.stdout.slice(0, 500)}`,
          );
        }
        const hit = sources.find((s) => s.browserKey === target.key);
        if (!hit) {
          throw new Error(
            `${target.key} not in sources list. Got keys: ${sources.map((s) => s.browserKey).join(', ')}`,
          );
        }
        // Multiple binaries can legitimately resolve to the same install
        // — e.g. on Ubuntu with Snap chromium, `/usr/bin/chromium` is a
        // transitional shim AND `/snap/bin/chromium` exists; the registry
        // picks the first existing candidate, either is correct.
        if (!target.binaryCandidates.includes(hit.binaryPath)) {
          throw new Error(
            `binaryPath ${hit.binaryPath} not in declared candidates: ${JSON.stringify(target.binaryCandidates)}`,
          );
        }
        if (hit.userDataDir !== userDataDir) {
          throw new Error(
            `userDataDir mismatch — expected ${userDataDir}, got ${hit.userDataDir}`,
          );
        }
      } finally {
        rmSync(userDataDir, { recursive: true, force: true });
      }
    });
    continue;
  }

  await check(`profile inspect --browser ${target.key} --profile Default --json`, async () => {
    if (!binary) {
      skip(`${target.key} not installed at any expected path — CI step missed?`);
    }
    seedUserDataDir(userDataDir);

    try {
      const r = await runWithCaptureRetry(
        ['profile', 'inspect', '--browser', target.key, '--profile', 'Default', '--json'],
        { timeoutMs: 90_000 },
      );
      if (r.status !== 0) {
        throw new Error(
          `exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout.slice(0, 500)}`,
        );
      }
      let parsed;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        throw new Error(`stdout not valid JSON: ${r.stdout.slice(0, 500)}`);
      }
      if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
        throw new Error(`malformed capture body: ${JSON.stringify(parsed).slice(0, 300)}`);
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}

cleanupTempRoot();

harness.printSummary({ exit: false });
if (harness.skipped > 0) {
  console.log('\nSkipped:');
  for (const s of harness.skipNotes) console.log(`  - ${s.label}: ${s.reason}`);
}
if (harness.failed > 0) process.exit(1);
