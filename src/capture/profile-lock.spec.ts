import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CaptureError } from '../errors.js';
import type { DetectedProfile } from '../browsers/discover.js';
import {
  createLockGate,
  formatAccessDeniedMessage,
  formatProfileLockedMessage,
  isWindowsLockError,
  probeReadable,
  type LockHandling,
  type LockedFile,
} from './profile-lock.js';

const profile: DetectedProfile = {
  browserKey: 'chrome',
  browserDisplayName: 'Google Chrome',
  profileDisplayName: 'Nick',
  profileDirName: 'Default',
  binaryPath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  userDataDir: path.resolve('synthetic-user-data'),
  profilePath: path.resolve('synthetic-user-data', 'Default'),
};
const relativePath = path.join('Default', 'Network', 'Cookies');
const cookiePath = path.join(profile.userDataDir, relativePath);
const busy = Object.assign(new Error('busy'), {
  code: 'EBUSY',
  path: cookiePath,
});
const denied = Object.assign(new Error('denied'), {
  code: 'EPERM',
  path: cookiePath,
});
const accessDeniedMessage = [
  `Can't capture Google Chrome / Nick: Windows denied access to ${relativePath} (EPERM).`,
  "Either your Windows account can't read this file, or another program is holding it (antivirus, backup or cloud-sync software, or Google Chrome itself if it is still running).",
  'Quit Google Chrome completely, wait a few seconds and re-run this command. If it keeps failing, check that your Windows account can read the files in this browser profile.',
].join('\n');
const rejectsDenied = (promise: Promise<unknown>) =>
  assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof CaptureError);
    assert.equal(err.code, 'profile-copy-failed');
    assert.equal(err.exitCode, 4);
    assert.equal(err.message, accessDeniedMessage);
    assert.ok(!err.message.includes('Google Chrome is still running'));
    assert.ok(!err.message.includes('is locked'));
    assert.ok(!err.message.includes(profile.userDataDir));
    return true;
  });
const locked = (browserRunning: boolean): LockedFile => ({
  relativePath,
  browserRunning,
  code: 'EBUSY',
});
const rejectsLocked = (promise: Promise<unknown>, text: string) =>
  assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof CaptureError);
    assert.equal(err.code, 'profile-file-locked');
    assert.equal(err.exitCode, 4);
    assert.ok(err.message.includes(text));
    assert.ok(!err.message.includes(profile.userDataDir));
    return true;
  });

const harness = (
  errors: (NodeJS.ErrnoException | null)[],
  overrides: Partial<LockHandling> = {},
) => {
  let time = 0;
  let index = 0;
  const sleeps: number[] = [];
  const probes: string[] = [];
  const waits: LockedFile[] = [];
  const gate = createLockGate(profile, {
    platform: 'win32',
    interactive: false,
    probe: async (p) => {
      probes.push(p);
      return errors[Math.min(index++, errors.length - 1)];
    },
    isBrowserRunning: async () => true,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    now: () => time,
    onWait: (file) => waits.push(file),
    ...overrides,
  });
  return { gate, sleeps, probes, waits };
};

describe('capture/profile-lock', () => {
  it('keeps lock guidance layout while escaping names and relative paths', () => {
    const hostile = {
      ...profile,
      browserDisplayName: 'Chrome\nforged',
      profileDisplayName: 'work\tforged',
      binaryPath: 'C:\\Chrome\\chrome\nforged.exe',
    };
    const file = { ...locked(true), relativePath: 'Default\\Network\nforged' };
    for (const [message, lines] of [
      [formatProfileLockedMessage(hostile, file, 'wait'), 2],
      [formatProfileLockedMessage(hostile, file, 'fail'), 4],
      [formatAccessDeniedMessage(hostile, file.relativePath), 3],
    ] as const) {
      assert.equal(message.split('\n').length, lines);
      assert.ok(message.includes('Chrome\\u000aforged'));
      assert.ok(message.includes('Default\\Network\\u000aforged'));
      assert.ok(!message.includes('\nforged'));
    }
  });

  it('classifies only Windows EBUSY and EPERM objects as locks', () => {
    const cases: [unknown, NodeJS.Platform, boolean][] = [
      [{ code: 'EBUSY' }, 'win32', true],
      [{ code: 'EPERM' }, 'win32', true],
      [{ code: 'EACCES' }, 'win32', false],
      [{ code: 'ENOENT' }, 'win32', false],
      [{ code: 'EBUSY' }, 'darwin', false],
      [{ code: 'EBUSY' }, 'linux', false],
      [undefined, 'win32', false],
      [null, 'win32', false],
      ['EBUSY', 'win32', false],
      [{}, 'win32', false],
    ];
    for (const [err, platform, expected] of cases)
      assert.equal(isWindowsLockError(err, platform), expected);
  });

  it('probes real files, missing paths and directories without leaking handles', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-probe-'));
    try {
      await fs.writeFile(path.join(dir, 'Cookies'), 'synthetic');
      assert.equal(await probeReadable(path.join(dir, 'Cookies')), null);
      assert.equal(await probeReadable(path.join(dir, 'missing')), null);
      assert.equal(await probeReadable(dir), null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('explains both lock holders and both terminal modes with relative paths', () => {
    assert.equal(
      formatProfileLockedMessage(profile, locked(true), 'fail'),
      [
        `Can't capture Google Chrome / Nick: ${relativePath} is locked (EBUSY) because Google Chrome is still running.`,
        'On Windows, Google Chrome keeps its cookie database locked while it runs, including in the background after its last window is closed.',
        'Quit Google Chrome completely (menu → Exit, or right-click its icon in the taskbar notification area → Exit; end any leftover chrome.exe processes in Task Manager), then re-run this command.',
        'To stop it running in the background, turn off "Continue running background apps" under Settings → System.',
      ].join('\n'),
    );
    assert.equal(
      formatProfileLockedMessage(profile, locked(false), 'fail'),
      [
        `Can't capture Google Chrome / Nick: ${relativePath} is locked (EBUSY) by another program.`,
        'Google Chrome is not running, but antivirus, backup or cloud-sync software can hold browser files open for a while. Wait a few seconds and re-run this command; if it keeps failing, restart Windows and try again.',
      ].join('\n'),
    );
    assert.equal(
      formatProfileLockedMessage(profile, locked(true), 'wait'),
      [
        `Google Chrome is still running, so Windows keeps ${relativePath} locked.`,
        'Quit Google Chrome completely now (menu → Exit, or right-click its icon in the taskbar notification area → Exit). The capture continues automatically once it has closed — waiting up to 2 minutes (Ctrl+C to cancel).',
      ].join('\n'),
    );
    assert.equal(
      formatProfileLockedMessage(profile, locked(false), 'wait'),
      `${relativePath} is locked by another program. Waiting up to 2 minutes for it to be released (Ctrl+C to cancel).`,
    );
  });

  it('never probes or retries on POSIX, including a copy-time EBUSY', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const h = harness([busy], { platform });
      await h.gate.ensureReadable(cookiePath);
      let attempts = 0;
      await assert.rejects(
        h.gate.retryOnLock(async () => {
          attempts++;
          throw busy;
        }),
        (err) => err === busy,
      );
      assert.equal(attempts, 1);
      assert.deepEqual(h.probes, []);
      assert.deepEqual(h.sleeps, []);
    }
  });

  it('does not wait for readable files or non-lock errors', async () => {
    for (const error of [
      null,
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    ]) {
      const h = harness([error]);
      await h.gate.ensureReadable(cookiePath);
      assert.deepEqual(h.sleeps, []);
    }
  });

  it('fails immediately without a TTY when the browser is running', async () => {
    const h = harness([busy]);
    await rejectsLocked(h.gate.ensureReadable(cookiePath), 'still running');
    assert.deepEqual(h.probes, [cookiePath]);
    assert.deepEqual(h.sleeps, []);
  });

  for (const interactive of [false, true]) {
    it(`retries EPERM briefly without a lock announcement (interactive=${interactive})`, async () => {
      const h = harness([denied, null], { interactive });
      await h.gate.ensureReadable(cookiePath);
      assert.deepEqual(h.sleeps, [1500]);
      assert.deepEqual(h.waits, []);
    });

    it(`reports persistent EPERM as access denied (interactive=${interactive})`, async () => {
      const h = harness([denied], { interactive });
      await rejectsDenied(h.gate.ensureReadable(cookiePath));
      assert.deepEqual(h.sleeps, [1500]);
      assert.deepEqual(h.waits, []);
    });
  }

  it('explains denied access without identifying a definite holder', () => {
    assert.equal(
      formatAccessDeniedMessage(profile, relativePath),
      accessDeniedMessage,
    );
  });

  it('uses the EBUSY flow when the permission retry finds a sharing lock', async () => {
    const h = harness([denied, busy]);
    await rejectsLocked(h.gate.ensureReadable(cookiePath), 'still running');
    assert.deepEqual(h.sleeps, [1500]);
    assert.deepEqual(h.waits, []);
  });

  it('reports access denied if the non-interactive lock retry finds EPERM', async () => {
    const h = harness([busy, denied], {
      isBrowserRunning: async () => false,
    });
    await rejectsDenied(h.gate.ensureReadable(cookiePath));
    assert.deepEqual(h.sleeps, [1500]);
  });

  it('stops polling a sharing lock when it becomes a persistent permission error', async () => {
    const h = harness([busy, denied], { interactive: true });
    await rejectsDenied(h.gate.ensureReadable(cookiePath));
    assert.deepEqual(h.sleeps, [1000, 1500]);
    assert.deepEqual(h.waits, [locked(true)]);
  });

  it('reports access denied on the second copy without a third attempt', async () => {
    const h = harness([null]);
    let attempts = 0;
    await rejectsDenied(
      h.gate.retryOnLock(async () => {
        attempts++;
        throw denied;
      }),
    );
    assert.equal(attempts, 2);
    assert.deepEqual(h.sleeps, []);
  });

  it('retries another program once after 1500 ms, then resumes or fails', async () => {
    for (const clears of [true, false]) {
      const h = harness([busy, clears ? null : busy], {
        isBrowserRunning: async () => false,
      });
      if (clears) await h.gate.ensureReadable(cookiePath);
      else
        await rejectsLocked(
          h.gate.ensureReadable(cookiePath),
          'another program',
        );
      assert.deepEqual(h.sleeps, [1500]);
      assert.deepEqual(h.probes, [cookiePath, cookiePath]);
    }
  });

  it('polls until readable and announces the wait once', async () => {
    const h = harness([busy, busy, busy, null], { interactive: true });
    await h.gate.ensureReadable(cookiePath);
    assert.deepEqual(h.sleeps, [1000, 1000, 1000]);
    assert.deepEqual(h.waits, [locked(true)]);
  });

  it('bounds a persistent interactive lock to two minutes', async () => {
    const h = harness([busy], { interactive: true });
    await rejectsLocked(h.gate.ensureReadable(cookiePath), 'still running');
    const total = h.sleeps.reduce((a, b) => a + b, 0);
    assert.ok(total >= 120000 && total <= 121000);
    assert.equal(h.waits.length, 1);
  });

  it('shares the deadline and announcement across files in one capture', async () => {
    const h = harness([busy, null, busy], { interactive: true });
    await h.gate.ensureReadable(cookiePath);
    await rejectsLocked(
      h.gate.ensureReadable(path.join(profile.profilePath, 'Cookies-journal')),
      'still running',
    );
    assert.equal(h.waits.length, 1);
    assert.equal(
      h.sleeps.reduce((a, b) => a + b, 0),
      120000,
    );
  });

  it('returns a successful copy without probing', async () => {
    const h = harness([busy]);
    assert.equal(await h.gate.retryOnLock(async () => 'copy'), 'copy');
    assert.deepEqual(h.probes, []);
  });

  it('retries a copy once using the failed path, or the profile path when absent', async () => {
    for (const error of [busy, { code: 'EPERM' }]) {
      const h = harness([null]);
      let attempts = 0;
      const result = await h.gate.retryOnLock(async () => {
        if (++attempts === 1) throw error;
        return 'copy';
      });
      assert.equal(result, 'copy');
      assert.equal(attempts, 2);
      assert.deepEqual(h.probes, [
        'path' in error ? cookiePath : profile.profilePath,
      ]);
    }
  });

  it('converts a second lock without attempting a third copy', async () => {
    const h = harness([null]);
    let attempts = 0;
    await rejectsLocked(
      h.gate.retryOnLock(async () => {
        attempts++;
        throw busy;
      }),
      'still running',
    );
    assert.equal(attempts, 2);
  });

  it('does not probe or wait until the failed attempt has cleaned up', async () => {
    const events: string[] = [];
    let probes = 0;
    const h = harness([], {
      interactive: true,
      probe: async () => {
        events.push('probe');
        return ++probes === 1 ? busy : null;
      },
      onWait: () => {
        events.push('wait');
      },
    });
    let attempts = 0;
    assert.equal(
      await h.gate.retryOnLock(async () => {
        if (++attempts > 1) return 'copy';
        try {
          throw busy;
        } finally {
          await Promise.resolve();
          events.push('cleanup');
        }
      }),
      'copy',
    );
    assert.deepEqual(events, ['cleanup', 'probe', 'wait', 'probe']);
  });

  it('preserves non-lock errors from either copy attempt', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    for (const failFirst of [true, false]) {
      const h = harness([null]);
      let attempts = 0;
      await assert.rejects(
        h.gate.retryOnLock(async () => {
          if (++attempts === 1 && !failFirst) throw busy;
          throw denied;
        }),
        (err) => err === denied,
      );
      assert.equal(attempts, failFirst ? 1 : 2);
    }
  });
});
