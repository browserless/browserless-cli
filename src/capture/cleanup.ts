import fs from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { killBrowser } from './launch.js';

/**
 * Build a capture's cleanup: stop the browser, then delete the temporary
 * profile copy (cookies included). It runs once — the normal `finally` and an
 * interrupt handler share the same run instead of racing each other.
 *
 * It waits for a launch that is still in flight: a signal can land while
 * `launchBrowser` is between its awaits and the spawn, and a cleanup that only
 * looked at an already-assigned child would leave that browser running once it
 * spawns.
 */
export const createCaptureCleanup = (
  /** Read at cleanup time: the copy may not have started, or may be partial. */
  tempUserDataDir: () => string | undefined,
  launching: () => Promise<{ child: ChildProcess }> | undefined,
  kill: (child: ChildProcess) => Promise<void> = killBrowser,
  /** Stop a profile copy that may still be writing into the temp dir. */
  abortCopy: () => void = () => undefined,
): (() => Promise<void>) => {
  let cleaning: Promise<void> | undefined;
  return () =>
    (cleaning ??= (async () => {
      abortCopy();
      const launched = await launching()?.catch(() => undefined);
      if (launched) await kill(launched.child);
      const dir = tempUserDataDir();
      if (dir) {
        // Retries cover the copy's last in-flight writes after the abort
        // (ENOTEMPTY), and files an exiting browser still holds (EBUSY).
        await fs
          .rm(dir, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          })
          .catch(() => undefined);
      }
    })());
};
