/**
 * Catches Chrome shipping new sensitive state files we don't yet filter.
 *
 * Boots a fresh user-data-dir under whichever Chromium-based browser is
 * available on the runner, runs `buildTempUserDataDir`, then matches every
 * surviving top-level entry against a sensitive-name pattern set. Anything
 * that looks like history / passwords / autofill / extensions / sync /
 * tracking-state and isn't already in `SKIP_SENSITIVE_ENTRIES` causes the
 * smoke to fail with a triage list.
 *
 * Symmetric check: essentials (`Cookies`, `Local Storage`, `IndexedDB`)
 * must survive so the capture pipeline still works.
 *
 * Run: `npm run test:copy-filter`
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  BUILT_IN_BROWSERS,
  findBuiltInByKeyOrName,
} from '../build/browsers/registry.js';
import {
  pickFreePort,
  waitForDebuggerEndpoint,
  killBrowser,
} from '../build/capture/launch.js';
import { buildTempUserDataDir } from '../build/capture/copy-profile.js';

/**
 * If the post-filter copy contains an entry whose name matches any of
 * these, the smoke fails — that's either a SKIP_SENSITIVE_ENTRIES miss
 * or a brand-new Chrome state file we need to triage.
 *
 * Regex on filenames (not paths). Conservative: false positives are
 * easy to fix (add to SKIP_SENSITIVE_ENTRIES or to the explicit-allow
 * list below), false negatives ship sensitive data into uploads.
 */
const SENSITIVE_PATTERNS = [
  /history/i,
  /^login data/i,
  /^web data/i,
  /^account web data/i,
  /^affiliation/i,
  /autofill/i,
  /passkey/i,
  /^trusted[ _]?vault/i,
  /^bookmark/i,
  /^top sites/i,
  /^visited links/i,
  /^favicons/i,
  /^shortcuts/i,
  /^network action predictor/i,
  /^dips/i,
  /^trust tokens/i,
  /^browsing\s?topics/i,
  /^reporting and nel/i,
  /^extensions?$/i,
  /^extension /i,
  /extension settings/i,
  /^sessions$/i,
  /^sync /i,
  /^web applications$/i,
  /^safe browsing cookies/i,
];

/**
 * Names matching a SENSITIVE_PATTERN that we've consciously decided are
 * fine to keep. Empty today — add here only with a one-line justification.
 */
const EXPLICITLY_ALLOWED = new Set([]);

const REQUIRED_FOR_CAPTURE = ['Cookies', 'Local Storage', 'IndexedDB'];

const parseArgs = () => {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--browser');
  if (idx === -1 || !args[idx + 1]) {
    return { browserKey: 'chrome' };
  }
  return { browserKey: args[idx + 1] };
};

const findBinary = async (browserKey) => {
  const entry = findBuiltInByKeyOrName(browserKey);
  if (!entry) {
    throw new Error(
      `Unknown browser "${browserKey}". Known: ${BUILT_IN_BROWSERS.map((b) => b.key).join(', ')}`,
    );
  }
  const candidates = entry.binaryPathByPlatform[process.platform] ?? [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { entry, binary: candidate };
    } catch {
      // try the next one
    }
  }
  return { entry, binary: null };
};

const bootBrowserBriefly = async (binary) => {
  // Reuses the same headless-warmup pattern as build-fixture-profile.js:
  // start the browser pointed at a fresh user-data-dir, wait for the
  // DevTools endpoint (proves it wrote out Local State + Default/), then
  // kill it. Whatever Chrome shipped in this version is now on disk.
  const tempUserDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'browserless-cli-copyfilter-'),
  );
  const port = await pickFreePort();
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempUserDataDir}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', () => undefined);
  try {
    await waitForDebuggerEndpoint(port);
  } finally {
    await killBrowser(child);
  }
  return tempUserDataDir;
};

const main = async () => {
  const { browserKey } = parseArgs();
  const { entry, binary } = await findBinary(browserKey);
  if (!binary) {
    console.log(
      `[copy-filter-smoke] no ${entry.displayName} binary on this host — skipping`,
    );
    return;
  }

  console.log(`[copy-filter-smoke] using ${entry.displayName} at ${binary}`);
  const sourceUserDataDir = await bootBrowserBriefly(binary);

  const profileShim = {
    browserKey: entry.key,
    browserDisplayName: entry.displayName,
    profileDirName: 'Default',
    profileDisplayName: 'Default',
    userDataDir: sourceUserDataDir,
    profilePath: path.join(sourceUserDataDir, 'Default'),
    binaryPath: binary,
  };

  let tempCopy;
  try {
    tempCopy = await buildTempUserDataDir(profileShim);
    const copyDefault = path.join(tempCopy, 'Default');
    const sourceDefault = path.join(sourceUserDataDir, 'Default');
    const entries = (await fs.readdir(copyDefault)).sort();
    const sourceEntries = new Set(await fs.readdir(sourceDefault));

    // 1) Surviving sensitive entries — should be empty.
    const leaks = entries.filter((name) => {
      if (EXPLICITLY_ALLOWED.has(name)) return false;
      return SENSITIVE_PATTERNS.some((re) => re.test(name));
    });

    // 2) Missing essentials — but only flag what Chrome actually wrote
    // out to the source. `IndexedDB/` etc. are lazily created on first
    // write, so a fresh `about:blank` boot won't have them, which is
    // fine. The smoke's job is "did our filter drop something that WAS
    // in the source," not "are all essentials always present."
    const missing = REQUIRED_FOR_CAPTURE.filter(
      (name) => sourceEntries.has(name) && !entries.includes(name),
    );

    console.log(
      `[copy-filter-smoke] ${entries.length} entries in post-filter Default/`,
    );

    if (leaks.length) {
      console.error('');
      console.error('❌ sensitive-looking entries leaked into the copy:');
      for (const name of leaks) console.error(`     ${name}`);
      console.error('');
      console.error(
        'Triage: either add these to SKIP_SENSITIVE_ENTRIES in src/capture/copy-profile.ts,',
      );
      console.error(
        'or — if they\'re actually needed by the capture pipeline — add them to',
      );
      console.error('EXPLICITLY_ALLOWED in this script with a one-line justification.');
    }

    if (missing.length) {
      console.error('');
      console.error('❌ essentials missing from the post-filter copy:');
      for (const name of missing) console.error(`     ${name}`);
      console.error('');
      console.error(
        'Triage: Chrome may have moved this state file. Check SKIP_CACHE_DIRS /',
      );
      console.error(
        'SKIP_SENSITIVE_ENTRIES in src/capture/copy-profile.ts for an over-broad match.',
      );
    }

    if (leaks.length || missing.length) {
      process.exitCode = 1;
      return;
    }

    console.log('[copy-filter-smoke] ✓ no sensitive leaks, all essentials present');
  } finally {
    if (tempCopy) await fs.rm(tempCopy, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(sourceUserDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
});
