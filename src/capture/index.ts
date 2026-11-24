import { DetectedProfile } from '../browsers/discover.js';
import { buildTempUserDataDir, sweepStaleTempDirs } from './copy-profile.js';
import { createCaptureCleanup } from './cleanup.js';
import {
  launchBrowserWithPipe,
  startAnsweringBrowser,
  waitForCdpPipe,
} from './launch.js';
import { captureViaCdp, OriginProgressEvent } from './cdp.js';
import { onInterrupt } from '../utils/interrupt.js';
import { CaptureError } from '../errors.js';
import { CaptureDiagnostics, ProfileAuthState } from './types.js';
import type { LockedFile } from './profile-lock.js';

/**
 * Coarse step the capture pipeline is currently in. Surfaces enough
 * granularity for a CLI to show a meaningful single-line indicator
 * during the multi-second steps (`copying`, `capturing-origins`) without
 * leaking CDP-loop internals.
 */
export type CapturePhase =
  | 'copying'
  | 'waiting-for-unlock'
  | 'launching'
  | 'waiting-for-debugger'
  | 'restarting-browser'
  | 'capturing-origins'
  | 'done';

export type CaptureProgressEvent =
  | { phase: Exclude<CapturePhase, 'capturing-origins' | 'waiting-for-unlock'> }
  | ({ phase: 'capturing-origins' } & OriginProgressEvent)
  | ({ phase: 'waiting-for-unlock' } & LockedFile);

export interface CaptureOptions {
  profile: DetectedProfile;
  /** A person at a terminal can quit the browser while capture waits. */
  interactive?: boolean;
  excludedDomains?: string[];
  /** Allowlist applied pre-navigation so the per-run cap isn't burned on origins that would be discarded post-capture. */
  onlyDomains?: string[];
  passwordStoreOverride?: string;
  /**
   * Notified at each phase change and once per attempted origin during
   * the CDP pass. The callback runs synchronously on the main loop —
   * keep it cheap (write a line, no async work).
   */
  onProgress?: (event: CaptureProgressEvent) => void;
}

export interface CaptureResult {
  state: ProfileAuthState;
  diagnostics: CaptureDiagnostics;
  /** Hint for the CLI: we hit the per-capture origin cap and skipped some. */
  capHit: boolean;
  /** True when password-store on Linux defaulted because detection failed. */
  passwordStoreDefaulted: boolean;
  /** Pre-serialized JSON the api layer reuses for the upload body. */
  serialized: string;
}

const startTime = (): bigint => process.hrtime.bigint();
const elapsedMs = (start: bigint): number =>
  Number((process.hrtime.bigint() - start) / 1_000_000n);

/**
 * Run the full local capture pipeline:
 *   copy → strip locks → launch headless → CDP capture → exclude → cleanup.
 *
 * Returns the captured ProfileAuthState plus diagnostics for the CLI to
 * render. Cleanup runs in a `finally` so a thrown CaptureError still leaves
 * a clean tmp dir behind.
 */
export const captureFromProfile = async (
  opts: CaptureOptions,
): Promise<CaptureResult> => {
  const t0 = startTime();
  const onProgress = opts.onProgress;

  // Phase 1: copy the user-data-dir. Heavy profiles spend 5–15s here
  // copying SQLite + LevelDB files, and that's the first thing the CLI
  // looks like it's "stuck" on after the "Capturing X / Y" banner.
  await sweepStaleTempDirs();

  // Known as soon as `mkdtemp` creates it, so an interrupt mid-copy still
  // deletes the partial copy.
  let tempUserDataDir: string | undefined;
  let launching: ReturnType<typeof launchBrowserWithPipe> | undefined;
  let passwordStoreDefaulted: boolean;

  const copyAbort = new AbortController();
  const cleanup = createCaptureCleanup(
    () => tempUserDataDir,
    () => launching,
    undefined,
    () => copyAbort.abort(),
  );
  // Ctrl-C would otherwise exit without running the `finally` below, leaving the
  // headless browser running and the profile copy (cookies included) on disk.
  // Registered before the copy, which can take 5–15 s on a heavy profile.
  const disposeInterrupt = onInterrupt(cleanup);

  try {
    onProgress?.({ phase: 'copying' });
    tempUserDataDir = await buildTempUserDataDir(
      opts.profile,
      {
        interactive: opts.interactive ?? false,
        onWait: (locked) =>
          onProgress?.({ phase: 'waiting-for-unlock', ...locked }),
      },
      (dir) => {
        tempUserDataDir = dir;
      },
      copyAbort.signal,
    );

    const userDataDir = tempUserDataDir;
    const startBrowser = async () => {
      // Cleanup aborts this signal synchronously as its first step, and this
      // check runs in the same tick as the assignment below, so an interrupt
      // that lands after the copy, or while a silent browser is being
      // stopped, can't be followed by a launch the cleanup never sees.
      if (copyAbort.signal.aborted) {
        throw new CaptureError(
          'Capture interrupted before the browser started',
          'profile-copy-failed',
        );
      }
      onProgress?.({ phase: 'launching' });
      launching = launchBrowserWithPipe({
        profile: opts.profile,
        userDataDir,
        passwordStoreOverride: opts.passwordStoreOverride,
      });
      const started = await launching;
      onProgress?.({ phase: 'waiting-for-debugger' });
      return started;
    };
    const launch = await startAnsweringBrowser(startBrowser, {
      onRestart: () => onProgress?.({ phase: 'restarting-browser' }),
    });
    passwordStoreDefaulted = launch.passwordStoreDefaulted;

    await waitForCdpPipe(launch.cdp, undefined, launch.diagnostics);

    onProgress?.({
      phase: 'capturing-origins',
      attempted: 0,
      total: 0,
      origin: '',
    });
    const captured = await captureViaCdp(
      opts.profile,
      launch.cdp,
      opts.excludedDomains ?? [],
      (event) => onProgress?.({ phase: 'capturing-origins', ...event }),
      opts.onlyDomains ?? [],
    );

    onProgress?.({ phase: 'done' });
    const serialized = JSON.stringify(captured.state);

    return {
      state: captured.state,
      diagnostics: {
        cookieCountBeforeExclusion: captured.cookieCountTotal,
        cookieCountExcluded: captured.cookieCountExcluded,
        // "BeforeExclusion" reads as pre-`--exclude-domain` only, but the
        // diagnostic conceptually means "all origins seen" — also includes
        // the `--only-domain` skips so the rendered "N origins" total is
        // accurate.
        originCountBeforeExclusion:
          captured.state.origins.length +
          captured.originCountSkippedByExclusion +
          captured.originCountSkippedByOnlyDomain,
        originCountExcluded: captured.originCountSkippedByExclusion,
        originCountSkippedByOnlyDomain: captured.originCountSkippedByOnlyDomain,
        excludedDomains: opts.excludedDomains ?? [],
        onlyDomains: opts.onlyDomains ?? [],
        durationMs: elapsedMs(t0),
        failedOrigins: captured.failedOrigins,
      },
      capHit: captured.capHit,
      passwordStoreDefaulted,
      serialized,
    };
  } finally {
    // Keep the interrupt handlers until the cleanup is done, so a Ctrl-C now
    // waits for it rather than exiting halfway through.
    await cleanup();
    disposeInterrupt();
  }
};

export type { ProfileAuthState } from './types.js';
