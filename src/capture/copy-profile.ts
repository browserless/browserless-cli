import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DetectedProfile } from '../browsers/discover.js';
import { CaptureError } from '../errors.js';
import {
  COOKIE_DB_FILES,
  createLockGate,
  isWindowsLockError,
  type LockHandling,
} from './profile-lock.js';

/**
 * Subdirs Chrome regenerates on launch — pure overhead in a copy. Skipping
 * them takes a typical `Default/` from hundreds of MB to ~80 MB.
 */
const SKIP_CACHE_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'Service Worker',
  'Crashpad',
  'optimization_guide_model_store',
  'Default Cache',
]);

/**
 * Defense in depth: Chromium SQLite files are coupled so the broad copy
 * is unavoidable for the headless launch, but the capture pipeline only
 * reads Cookies + Local Storage + IndexedDB via CDP. Anything else can
 * be dropped from the temp copy so private bytes don't leave the source
 * dir at all.
 */
const SKIP_SENSITIVE_ENTRIES = new Set([
  'History',
  'History-journal',
  'History Provider Cache',
  'Top Sites',
  'Top Sites-journal',
  'Visited Links',
  'Favicons',
  'Favicons-journal',
  'Shortcuts',
  'Shortcuts-journal',
  'Network Action Predictor',
  'Network Action Predictor-journal',
  'Login Data',
  'Login Data-journal',
  'Login Data For Account',
  'Login Data For Account-journal',
  'Web Data',
  'Web Data-journal',
  'Account Web Data',
  'Account Web Data-journal',
  'Affiliation Database',
  'Affiliation Database-journal',
  'AutofillStrikeDatabase',
  'AutofillAiModelCache',
  'passkey_enclave_state',
  'trusted_vault.pb',
  'Bookmarks',
  'Bookmarks.bak',
  'BookmarkMergedSurfaceOrdering',
  'DIPS',
  'DIPS-shm',
  'DIPS-wal',
  'Trust Tokens',
  'Trust Tokens-journal',
  'BrowsingTopicsState',
  'BrowsingTopicsSiteData',
  'BrowsingTopicsSiteData-journal',
  'Reporting and NEL',
  'Reporting and NEL-journal',
  'SCT Auditing Pending Reports',
  'Extensions',
  'Extension Cookies',
  'Extension Cookies-journal',
  'Extension Rules',
  'Extension Scripts',
  'Extension State',
  'Local Extension Settings',
  'Managed Extension Settings',
  'Sync Extension Settings',
  'Sessions',
  'Sync Data',
  'Sync App Settings',
  'Web Applications',
  'Platform Notifications',
  'Download Service',
  'chrome_cart_db',
  'commerce_subscription_db',
  'discount_infos_db',
  'discounts_db',
  'parcel_tracking_db',
  'heavy_ad_intervention_opt_out.db',
  'heavy_ad_intervention_opt_out.db-journal',
  // Safe Browsing has its own cookies file independent of `Cookies` — the
  // capture only reads the latter.
  'Safe Browsing Cookies',
  'Safe Browsing Cookies-journal',
]);

/**
 * Singletons that pin the source profile to the user's running browser.
 * Stripped from the copy so the headless instance can boot without
 * colliding with a still-running user browser.
 */
const SINGLETONS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/**
 * Build a temporary `--user-data-dir` mirroring the user's profile, with
 * cache subdirs and singleton locks stripped. Returns the path to the new
 * temp root — the caller is responsible for cleanup.
 */
export const buildTempUserDataDir = async (
  profile: DetectedProfile,
  lock: LockHandling = { interactive: false },
  /** Called with each temp dir right after it is created, before copying into it. */
  onTempDir?: (dir: string) => void,
  /** Aborting stops the copy at the next entry and removes the temp dir. */
  signal?: AbortSignal,
): Promise<string> => {
  const gate = createLockGate(profile, lock);
  const platform = lock.platform ?? process.platform;
  for (const file of COOKIE_DB_FILES) {
    await gate.ensureReadable(path.join(profile.profilePath, file));
  }
  return gate.retryOnLock(() => copyOnce(profile, platform, onTempDir, signal));
};

/** `fs.mkdtemp` appends six random characters to this prefix — more on some BSDs. */
const CAPTURE_TEMP_PREFIX = 'browserless-cli-';
const CAPTURE_TEMP_DIR = /^browserless-cli-[A-Za-z0-9]{6,}$/;
const STALE_TEMP_DIR_MS = 60 * 60 * 1000;

/**
 * Remove capture temp dirs an earlier run could not clean up — killed with
 * SIGKILL, interrupted mid-copy, or crashed. Each holds a copy of the user's
 * cookie database, so it must not linger. Only dirs older than `maxAgeMs` go:
 * a concurrent capture still owns its fresh one. Symlinks are never followed.
 *
 * On POSIX only dirs owned by the current user go. `os.tmpdir()` is usually the
 * shared `/tmp` on Linux, where another user can plant a matching, world-writable
 * dir and swap entries for symlinks mid-delete to steer the recursive `rm` into
 * this user's files. The CLI's own dirs come from `fs.mkdtemp` (mode 0700), so
 * nobody else can change what is inside them.
 *
 * Best-effort by design — a leftover that can't be removed yet (an orphaned
 * browser still holds a file on Windows) is retried on the next run instead of
 * failing this capture.
 */
export const sweepStaleTempDirs = async ({
  dir = os.tmpdir(),
  maxAgeMs = STALE_TEMP_DIR_MS,
  now = Date.now(),
  uid = process.getuid?.(),
}: {
  dir?: string;
  maxAgeMs?: number;
  now?: number;
  /** Owner to require; `undefined` (Windows) skips the check. */
  uid?: number;
} = {}): Promise<void> => {
  const names = await fs.readdir(dir).catch((): string[] => []);
  await Promise.all(
    names
      .filter((name) => CAPTURE_TEMP_DIR.test(name))
      .map(async (name) => {
        const target = path.join(dir, name);
        const stat = await fs.lstat(target).catch(() => null);
        if (!stat?.isDirectory() || now - stat.mtimeMs < maxAgeMs) return;
        if (uid !== undefined && stat.uid !== uid) return;
        await fs
          .rm(target, { recursive: true, force: true })
          .catch(() => undefined);
      }),
  );
};

const copyOnce = async (
  profile: DetectedProfile,
  platform: NodeJS.Platform,
  onTempDir?: (dir: string) => void,
  signal?: AbortSignal,
): Promise<string> => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), CAPTURE_TEMP_PREFIX),
  );
  onTempDir?.(tempRoot);

  // Local State at the user-data-dir root carries the profile registry —
  // missing it makes Chrome rebuild on first launch and our --profile-directory
  // resolution falls apart. ENOENT is acceptable (older browser versions
  // sometimes don't have it yet); anything else (EACCES, EISDIR, disk full)
  // must surface — silently degrading produces an empty capture the user
  // can't debug.
  const sourceLocalState = path.join(profile.userDataDir, 'Local State');
  const targetLocalState = path.join(tempRoot, 'Local State');
  try {
    await fs.copyFile(sourceLocalState, targetLocalState);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      await fs
        .rm(tempRoot, { recursive: true, force: true })
        .catch(() => undefined);
      if (isWindowsLockError(err, platform)) throw err;
      throw new CaptureError(
        `Failed to copy ${sourceLocalState} (${code ?? 'unknown error'}): ${(err as Error).message}`,
        'profile-copy-failed',
      );
    }
  }

  // First Run marker suppresses the welcome dialog. Writing the empty
  // marker should never fail on a freshly-mkdtemp'd dir we just created;
  // if it does, the temp dir is broken (EROFS / EDQUOT) and the capture
  // can't proceed anyway.
  try {
    await fs.writeFile(path.join(tempRoot, 'First Run'), '');
  } catch (err) {
    await fs
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
    throw new CaptureError(
      `Failed to write First Run marker in ${tempRoot}: ${(err as Error).message}`,
      'profile-copy-failed',
    );
  }

  const targetProfileDir = path.join(tempRoot, profile.profileDirName);

  try {
    await fs.cp(profile.profilePath, targetProfileDir, {
      recursive: true,
      force: true,
      filter: (src) => {
        if (signal?.aborted) return false;
        const rel = path.relative(profile.profilePath, src);
        if (!rel) return true;
        const top = rel.split(path.sep)[0];
        if (SKIP_CACHE_DIRS.has(top)) return false;
        if (SKIP_SENSITIVE_ENTRIES.has(top)) return false;
        return true;
      },
    });
  } catch (err: any) {
    await fs
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
    if (isWindowsLockError(err, platform)) throw err;
    throw new CaptureError(
      `Failed to copy profile from ${profile.profilePath}: ${err?.message ?? err}`,
      'profile-copy-failed',
    );
  }

  if (signal?.aborted) {
    await fs
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
    throw new CaptureError(
      'Profile copy interrupted before it finished',
      'profile-copy-failed',
    );
  }

  await Promise.all(
    SINGLETONS.flatMap((lock) => [
      fs.unlink(path.join(tempRoot, lock)).catch(() => undefined),
      fs.unlink(path.join(targetProfileDir, lock)).catch(() => undefined),
    ]),
  );

  return tempRoot;
};
