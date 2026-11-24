import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../utils/fs.js';

/**
 * Whether the browser that owns `userDataDir` currently has it open.
 *
 * Chromium uses a lock file in the user-data-dir to signal liveness, but
 * the filename AND content differ by platform:
 *   - macOS / Linux: `SingletonLock` — symlink whose target is `<host>-<pid>`.
 *     We readlink, parse, and validate the PID with `process.kill(pid, 0)`.
 *   - Windows: `lockfile` — an *empty marker file*. The real mutual
 *     exclusion is a Win32 named mutex, which we can't observe from Node.
 *     Presence of the file is our best signal; we sacrifice PID-based
 *     liveness checking (a stale `lockfile` from a crashed Chrome would
 *     read as locked until the user deletes it manually, matching
 *     Chrome's own behavior when restarted into the same profile).
 */
export interface LockStatus {
  locked: boolean;
  pid?: number;
  hostname?: string;
}

const parseTarget = (raw: string): { hostname: string; pid: number } | null => {
  const m = raw.trim().match(/^(.+)-(\d+)$/);
  if (!m) return null;
  return { hostname: m[1], pid: Number(m[2]) };
};

/**
 * Cross-platform PID liveness check.
 *
 * Note for future contributors: browser-use's Python equivalent has a
 * Windows-specific ctypes branch because Python's `os.kill(pid, 0)`
 * actually calls `TerminateProcess` on Windows (it's destructive).
 * **Node's `process.kill(pid, 0)` does not** — libuv special-cases
 * signal 0 to call `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, ...)`
 * and immediately close the handle, which is the same approach
 * browser-use's ctypes branch uses. So this single implementation is
 * correct on macOS, Linux, AND Windows. Don't add a defensive Windows
 * branch — it would be a no-op or worse.
 */
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readSymlinkTarget = async (lockPath: string): Promise<string | null> => {
  try {
    return await fs.readlink(lockPath);
  } catch {
    return null;
  }
};

export const checkProfileLock = async (
  userDataDir: string,
): Promise<LockStatus> => {
  if (process.platform === 'win32') {
    // Empty marker file — its presence is the signal.
    return (await pathExists(path.join(userDataDir, 'lockfile')))
      ? { locked: true }
      : { locked: false };
  }

  const target = await readSymlinkTarget(path.join(userDataDir, 'SingletonLock'));
  if (target === null) return { locked: false };
  const parsed = parseTarget(target);
  if (!parsed) return { locked: false };
  if (!isPidAlive(parsed.pid)) {
    return { locked: false, pid: parsed.pid, hostname: parsed.hostname };
  }
  return { locked: true, pid: parsed.pid, hostname: parsed.hostname };
};
