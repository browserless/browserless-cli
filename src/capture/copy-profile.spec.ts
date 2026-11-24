import { expect } from 'chai';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTempUserDataDir, sweepStaleTempDirs } from './copy-profile.js';
import { DetectedProfile } from '../browsers/discover.js';
import { CaptureError } from '../errors.js';
import { expectRejects } from '../test-helpers/assertions.js';

/** Top-level entries seeded into the fake source so the SKIP_SENSITIVE_ENTRIES filter can be exercised. */
const SENSITIVE_FILES = [
  'History',
  'History-journal',
  'Login Data',
  'Login Data-journal',
  'Login Data For Account',
  'Web Data',
  'Account Web Data',
  'Affiliation Database',
  'Affiliation Database-journal',
  'AutofillStrikeDatabase',
  'passkey_enclave_state',
  'trusted_vault.pb',
  'Bookmarks',
  'Bookmarks.bak',
  'Top Sites',
  'Visited Links',
  'Favicons',
  'Shortcuts',
  'Network Action Predictor',
  'DIPS',
  'DIPS-shm',
  'DIPS-wal',
  'Trust Tokens',
  'BrowsingTopicsState',
  'BrowsingTopicsSiteData',
  'Reporting and NEL',
  'Safe Browsing Cookies',
];

const SENSITIVE_DIRS = [
  'Extensions',
  'Local Extension Settings',
  'Managed Extension Settings',
  'Sync Extension Settings',
  'Sessions',
  'Sync Data',
  'Sync App Settings',
  'Web Applications',
  'Platform Notifications',
];

/** Files / dirs the capture pipeline depends on — must survive the filter. */
const ESSENTIAL_FILES = [
  'Cookies',
  'Cookies-journal',
  'Preferences',
  'Secure Preferences',
];
const ESSENTIAL_DIRS = ['Local Storage', 'IndexedDB'];

/**
 * Build a self-contained fake user-data-dir for the copy-profile tests.
 * We don't depend on a real Chrome profile here — the test verifies the
 * filter / strip behavior, not anything Chrome-specific.
 */
const buildFakeUserDataDir = async (): Promise<string> => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'browserless-cli-cpsrc-'),
  );
  await fs.writeFile(
    path.join(root, 'Local State'),
    JSON.stringify({
      profile: { info_cache: { Default: { name: 'Personal' } } },
    }),
  );
  const profileDir = path.join(root, 'Default');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'SingletonLock'), 'stub');
  await fs.mkdir(path.join(profileDir, 'Cache'), { recursive: true });
  await fs.writeFile(
    path.join(profileDir, 'Cache', 'big-cache.bin'),
    'should-be-skipped',
  );
  for (const f of [...ESSENTIAL_FILES, ...SENSITIVE_FILES]) {
    await fs.writeFile(path.join(profileDir, f), `stub-${f}`);
  }
  for (const d of [...ESSENTIAL_DIRS, ...SENSITIVE_DIRS]) {
    await fs.mkdir(path.join(profileDir, d), { recursive: true });
    await fs.writeFile(path.join(profileDir, d, 'inner'), `stub-${d}`);
  }
  return root;
};

const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

describe('capture/copy-profile.buildTempUserDataDir', () => {
  let sourceUserDataDir: string;
  let cleanupTargets: string[] = [];

  beforeEach(async () => {
    sourceUserDataDir = await buildFakeUserDataDir();
    cleanupTargets.push(sourceUserDataDir);
  });

  afterEach(async () => {
    for (const t of cleanupTargets) {
      await fs.rm(t, { recursive: true, force: true });
    }
    cleanupTargets = [];
  });

  const profile = (): DetectedProfile => ({
    browserKey: 'chrome',
    browserDisplayName: 'Google Chrome',
    profileDirName: 'Default',
    profileDisplayName: 'Personal',
    userDataDir: sourceUserDataDir,
    profilePath: path.join(sourceUserDataDir, 'Default'),
    binaryPath: '/usr/bin/false',
  });

  it('refuses a Windows cookie lock before writing any temporary data', async () => {
    const tempBase = await fs.mkdtemp(
      path.join(os.tmpdir(), 'lock-preflight-'),
    );
    cleanupTargets.push(tempBase);
    const env = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    Object.assign(process.env, {
      TMPDIR: tempBase,
      TEMP: tempBase,
      TMP: tempBase,
    });
    try {
      await assert.rejects(
        buildTempUserDataDir(profile(), {
          interactive: false,
          platform: 'win32',
          probe: async (p) =>
            p.endsWith(path.join('Network', 'Cookies'))
              ? Object.assign(new Error('busy'), { code: 'EBUSY' })
              : null,
          isBrowserRunning: async () => true,
        }),
        (err: unknown) => {
          assert.equal((err as { code: string }).code, 'profile-file-locked');
          assert.equal((err as { exitCode: number }).exitCode, 4);
          assert.ok(
            (err as Error).message.includes(
              path.join('Default', 'Network', 'Cookies'),
            ),
          );
          assert.ok(!(err as Error).message.includes(sourceUserDataDir));
          return true;
        },
      );
      expect(await fs.readdir(tempBase)).to.deep.equal([]);
    } finally {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('preserves the complete copy when Windows probes find no lock', async () => {
    const temp = await buildTempUserDataDir(profile(), {
      interactive: false,
      platform: 'win32',
      probe: async () => null,
    });
    cleanupTargets.push(temp);
    for (const file of [
      'Local State',
      'First Run',
      path.join('Default', 'Cookies'),
    ]) {
      expect(await exists(path.join(temp, file))).to.be.true;
    }
  });

  it('reports its temp dir as soon as it exists, before the copy finishes', async () => {
    // Lets an interrupt during the copy delete the partial copy (cookies
    // included) instead of leaving it for a later sweep.
    const reported: Array<{ dir: string; copied: boolean }> = [];
    const temp = await buildTempUserDataDir(
      profile(),
      { interactive: false },
      (dir) => {
        reported.push({
          dir,
          copied: existsSync(path.join(dir, 'Default', 'Preferences')),
        });
      },
    );
    cleanupTargets.push(temp);

    expect(reported).to.deep.equal([{ dir: temp, copied: false }]);
  });

  it('stops copying and removes its temp dir once aborted', async () => {
    // Ctrl-C mid-copy aborts the copy; without this, fs.cp kept writing into
    // the temp dir while cleanup deleted it, and recreated part of the tree.
    const controller = new AbortController();
    let created: string | undefined;
    const err = await expectRejects(
      () =>
        buildTempUserDataDir(
          profile(),
          { interactive: false },
          (dir) => {
            created = dir;
            controller.abort();
          },
          controller.signal,
        ),
      CaptureError,
      /interrupted/,
    );
    expect(err.code).to.equal('profile-copy-failed');
    expect(created).to.be.a('string');
    expect(await exists(created as string)).to.equal(false);
  });

  it('copies the profile and Local State', async () => {
    const temp = await buildTempUserDataDir(profile());
    cleanupTargets.push(temp);

    expect(await exists(path.join(temp, 'Local State'))).to.be.true;
    expect(await exists(path.join(temp, 'Default', 'Preferences'))).to.be.true;
    expect(await exists(path.join(temp, 'Default', 'Cookies'))).to.be.true;
  });

  it('writes a First Run marker', async () => {
    const temp = await buildTempUserDataDir(profile());
    cleanupTargets.push(temp);
    expect(await exists(path.join(temp, 'First Run'))).to.be.true;
  });

  it('skips Cache subdirs', async () => {
    const temp = await buildTempUserDataDir(profile());
    cleanupTargets.push(temp);
    expect(await exists(path.join(temp, 'Default', 'Cache'))).to.be.false;
  });

  it('strips SingletonLock from the profile dir', async () => {
    const temp = await buildTempUserDataDir(profile());
    cleanupTargets.push(temp);
    expect(await exists(path.join(temp, 'Default', 'SingletonLock'))).to.be
      .false;
  });

  describe('SKIP_SENSITIVE_ENTRIES', () => {
    // Build the temp dir once for all assertions — they're read-only and
    // hitting `buildTempUserDataDir` repeatedly is ~80 ms per call.
    let temp: string;
    beforeEach(async () => {
      temp = await buildTempUserDataDir(profile());
      cleanupTargets.push(temp);
    });

    it('drops every known sensitive top-level file', async () => {
      const leaked: string[] = [];
      for (const f of SENSITIVE_FILES) {
        if (await exists(path.join(temp, 'Default', f))) leaked.push(f);
      }
      expect(leaked, `unexpectedly copied: ${leaked.join(', ')}`).to.deep.equal(
        [],
      );
    });

    it('drops every known sensitive subdir', async () => {
      const leaked: string[] = [];
      for (const d of SENSITIVE_DIRS) {
        if (await exists(path.join(temp, 'Default', d))) leaked.push(d);
      }
      expect(leaked, `unexpectedly copied: ${leaked.join(', ')}`).to.deep.equal(
        [],
      );
    });

    it('keeps every essential file the capture pipeline depends on', async () => {
      const missing: string[] = [];
      for (const f of ESSENTIAL_FILES) {
        if (!(await exists(path.join(temp, 'Default', f)))) missing.push(f);
      }
      expect(
        missing,
        `essentials missing: ${missing.join(', ')}`,
      ).to.deep.equal([]);
    });

    it('keeps every essential subdir the capture pipeline depends on', async () => {
      const missing: string[] = [];
      for (const d of ESSENTIAL_DIRS) {
        if (!(await exists(path.join(temp, 'Default', d, 'inner'))))
          missing.push(d);
      }
      expect(
        missing,
        `essentials missing: ${missing.join(', ')}`,
      ).to.deep.equal([]);
    });
  });
});

describe('capture/copy-profile.sweepStaleTempDirs', () => {
  let sandbox: string;
  const HOUR = 60 * 60 * 1000;
  const now = Date.now();

  const makeDir = async (name: string, ageMs: number) => {
    const dir = path.join(sandbox, name);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'Cookies'), 'x');
    const at = new Date(now - ageMs);
    await fs.utimes(dir, at, at);
    return dir;
  };

  const exists = (dir: string) =>
    fs.stat(dir).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-sandbox-'));
  });
  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('removes capture temp dirs left behind by an interrupted run', async () => {
    const stale = await makeDir('browserless-cli-Ab12Cd', 2 * HOUR);

    await sweepStaleTempDirs({ dir: sandbox, maxAgeMs: HOUR, now });

    expect(await exists(stale)).to.equal(false);
  });

  it('also matches longer mkdtemp suffixes (some BSDs append more than six)', async () => {
    const stale = await makeDir('browserless-cli-Ab12Cd34Ef', 2 * HOUR);

    await sweepStaleTempDirs({ dir: sandbox, maxAgeMs: HOUR, now });

    expect(await exists(stale)).to.equal(false);
  });

  it('keeps recent capture dirs (a concurrent run may still own them)', async () => {
    const fresh = await makeDir('browserless-cli-Ef34Gh', 5 * 60 * 1000);

    await sweepStaleTempDirs({ dir: sandbox, maxAgeMs: HOUR, now });

    expect(await exists(fresh)).to.equal(true);
  });

  it('never touches a stale capture dir another user owns (shared /tmp)', async function () {
    if (process.platform === 'win32') this.skip();
    const foreign = await makeDir('browserless-cli-Qr90St', 2 * HOUR);
    const { uid } = await fs.stat(foreign);

    // Pretend this process runs as a different user than the dir's owner.
    await sweepStaleTempDirs({
      dir: sandbox,
      maxAgeMs: HOUR,
      now,
      uid: uid + 1,
    });

    expect(await exists(foreign)).to.equal(true);
  });

  it('ignores dirs that are not capture temp dirs', async () => {
    const testHome = await makeDir('browserless-cli-test-Ij56Kl', 2 * HOUR);
    const other = await makeDir('someone-else-Mn78Op', 2 * HOUR);

    await sweepStaleTempDirs({ dir: sandbox, maxAgeMs: HOUR, now });

    expect(await exists(testHome)).to.equal(true);
    expect(await exists(other)).to.equal(true);
  });

  it('never throws, even when the temp root is missing', async () => {
    await sweepStaleTempDirs({
      dir: path.join(sandbox, 'does-not-exist'),
      maxAgeMs: HOUR,
      now,
    });
  });
});
