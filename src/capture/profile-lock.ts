import fs from 'node:fs/promises';
import path from 'node:path';
import { checkProfileLock } from '../browsers/lock.js';
import type { DetectedProfile } from '../browsers/discover.js';
import { CaptureError } from '../errors.js';
import { terminalSafe } from '../utils/terminal.js';

export const LOCK_WAIT_TIMEOUT_MS = 120_000;
export const LOCK_POLL_MS = 1_000;
export const LOCK_RETRY_DELAY_MS = 1_500;

export const COOKIE_DB_FILES: readonly string[] = [
  path.join('Network', 'Cookies'),
  path.join('Network', 'Cookies-journal'),
  'Cookies',
  'Cookies-journal',
];

export interface LockedFile {
  /** Relative to the browser's user-data-dir, never the full local path. */
  relativePath: string;
  browserRunning: boolean;
  code: string;
}

export interface LockHandling {
  interactive: boolean;
  onWait?: (locked: LockedFile) => void;
  platform?: NodeJS.Platform;
  probe?: (absPath: string) => Promise<NodeJS.ErrnoException | null>;
  isBrowserRunning?: (userDataDir: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
  retryDelayMs?: number;
}

export const isWindowsLockError = (
  err: unknown,
  platform: NodeJS.Platform = process.platform,
): err is NodeJS.ErrnoException & { code: 'EBUSY' | 'EPERM' } =>
  platform === 'win32' &&
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  (err.code === 'EBUSY' || err.code === 'EPERM');

export const probeReadable = async (
  absPath: string,
): Promise<NodeJS.ErrnoException | null> => {
  try {
    // Windows rejects fs.open on directories even when they are readable.
    const handle = (await fs.stat(absPath)).isDirectory()
      ? await fs.opendir(absPath)
      : await fs.open(absPath, 'r');
    await handle.close();
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? null
      : (err as NodeJS.ErrnoException);
  }
};

export const formatProfileLockedMessage = (
  profile: Pick<
    DetectedProfile,
    'browserDisplayName' | 'profileDisplayName' | 'binaryPath'
  >,
  locked: LockedFile,
  mode: 'fail' | 'wait',
  timeoutMs = LOCK_WAIT_TIMEOUT_MS,
): string => {
  const name = terminalSafe(profile.browserDisplayName);
  const profileName = terminalSafe(profile.profileDisplayName);
  const rel = terminalSafe(locked.relativePath);
  const code = terminalSafe(locked.code);
  const { browserRunning } = locked;
  const exe = terminalSafe(path.win32.basename(profile.binaryPath));
  const minutes = Math.round(timeoutMs / 60_000);
  if (mode === 'wait') {
    return browserRunning
      ? [
          `${name} is still running, so Windows keeps ${rel} locked.`,
          `Quit ${name} completely now (menu → Exit, or right-click its icon in the taskbar notification area → Exit). The capture continues automatically once it has closed — waiting up to ${minutes} minutes (Ctrl+C to cancel).`,
        ].join('\n')
      : `${rel} is locked by another program. Waiting up to ${minutes} minutes for it to be released (Ctrl+C to cancel).`;
  }
  return browserRunning
    ? [
        `Can't capture ${name} / ${profileName}: ${rel} is locked (${code}) because ${name} is still running.`,
        `On Windows, ${name} keeps its cookie database locked while it runs, including in the background after its last window is closed.`,
        `Quit ${name} completely (menu → Exit, or right-click its icon in the taskbar notification area → Exit; end any leftover ${exe} processes in Task Manager), then re-run this command.`,
        'To stop it running in the background, turn off "Continue running background apps" under Settings → System.',
      ].join('\n')
    : [
        `Can't capture ${name} / ${profileName}: ${rel} is locked (${code}) by another program.`,
        `${name} is not running, but antivirus, backup or cloud-sync software can hold browser files open for a while. Wait a few seconds and re-run this command; if it keeps failing, restart Windows and try again.`,
      ].join('\n');
};

export const formatAccessDeniedMessage = (
  profile: Pick<DetectedProfile, 'browserDisplayName' | 'profileDisplayName'>,
  relativePath: string,
): string =>
  [
    `Can't capture ${terminalSafe(profile.browserDisplayName)} / ${terminalSafe(profile.profileDisplayName)}: Windows denied access to ${terminalSafe(relativePath)} (EPERM).`,
    `Either your Windows account can't read this file, or another program is holding it (antivirus, backup or cloud-sync software, or ${terminalSafe(profile.browserDisplayName)} itself if it is still running).`,
    `Quit ${terminalSafe(profile.browserDisplayName)} completely, wait a few seconds and re-run this command. If it keeps failing, check that your Windows account can read the files in this browser profile.`,
  ].join('\n');

export interface LockGate {
  ensureReadable(absPath: string): Promise<void>;
  retryOnLock<T>(attempt: () => Promise<T>): Promise<T>;
}

export const createLockGate = (
  profile: DetectedProfile,
  lock: LockHandling,
): LockGate => {
  const platform = lock.platform ?? process.platform;
  const probe = lock.probe ?? probeReadable;
  const isBrowserRunning =
    lock.isBrowserRunning ??
    (async (dir) => (await checkProfileLock(dir)).locked);
  const sleep =
    lock.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = lock.now ?? Date.now;
  const timeoutMs = lock.timeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const pollMs = lock.pollMs ?? LOCK_POLL_MS;
  const retryDelayMs = lock.retryDelayMs ?? LOCK_RETRY_DELAY_MS;
  let deadline: number | undefined;
  let announced = false;

  const fileError = async (
    absPath: string,
    code: string,
  ): Promise<CaptureError> => {
    if (code === 'EPERM') {
      return new CaptureError(
        formatAccessDeniedMessage(
          profile,
          path.relative(profile.userDataDir, absPath),
        ),
        'profile-copy-failed',
      );
    }
    return new CaptureError(
      formatProfileLockedMessage(
        profile,
        {
          relativePath: path.relative(profile.userDataDir, absPath),
          browserRunning: await isBrowserRunning(profile.userDataDir),
          code,
        },
        'fail',
      ),
      'profile-file-locked',
    );
  };

  const probeWithPermissionRetry = async (absPath: string) => {
    let err = await probe(absPath);
    if (err?.code === 'EPERM') {
      await sleep(retryDelayMs);
      err = await probe(absPath);
      if (err?.code === 'EPERM') throw await fileError(absPath, err.code);
    }
    return err;
  };

  const ensureReadable = async (absPath: string): Promise<void> => {
    if (platform !== 'win32') return;
    let err = await probeWithPermissionRetry(absPath);
    if (!isWindowsLockError(err, platform)) return;
    const browserRunning = await isBrowserRunning(profile.userDataDir);
    if (!lock.interactive) {
      if (browserRunning) throw await fileError(absPath, err.code);
      await sleep(retryDelayMs);
      err = await probe(absPath);
      if (isWindowsLockError(err, platform))
        throw await fileError(absPath, err.code);
      return;
    }
    deadline ??= now() + timeoutMs;
    if (!announced) {
      lock.onWait?.({
        relativePath: path.relative(profile.userDataDir, absPath),
        browserRunning,
        code: err.code,
      });
      announced = true;
    }
    while (now() < deadline) {
      await sleep(pollMs);
      err = await probeWithPermissionRetry(absPath);
      if (!isWindowsLockError(err, platform)) return;
    }
    throw await fileError(absPath, err.code);
  };

  const retryOnLock = async <T>(attempt: () => Promise<T>): Promise<T> => {
    try {
      return await attempt();
    } catch (err) {
      if (!isWindowsLockError(err, platform)) throw err;
      // The attempt owns cleanup; no copied auth data may remain during a wait.
      await ensureReadable(err.path ?? profile.profilePath);
    }
    try {
      return await attempt();
    } catch (err) {
      if (isWindowsLockError(err, platform))
        throw await fileError(err.path ?? profile.profilePath, err.code);
      throw err;
    }
  };
  return { ensureReadable, retryOnLock };
};
