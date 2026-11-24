import net from 'node:net';
import path from 'node:path';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { DetectedProfile } from '../browsers/discover.js';
import { resolveLinuxPasswordStore } from '../browsers/password-store.js';
import { CaptureError } from '../errors.js';
import { CDP_PIPE_CLOSED, CdpPipe, connectCdpPipe } from './cdp-pipe.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pick a free TCP port by binding to 0 and reading what the OS hands back.
 * Avoids hardcoding 9222 (collides with a user already running Chrome with
 * remote debugging enabled).
 */
export const pickFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => {
        if (typeof addr === 'object' && addr) resolve(addr.port);
        else reject(new Error('Could not pick a free port'));
      });
    });
  });

export interface LaunchDiagnostics {
  getStderr: () => string;
  getProcessState: () => {
    pid: number | undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    spawnfile: string;
    spawnargs: string[];
  };
}

/**
 * Wait for the launched browser to expose its CDP endpoint. The default
 * 15s suits most end-user environments; CI runners with slow first-run
 * XPC chatter (macOS in particular) can bump it via the
 * `BROWSERLESS_CDP_WAIT_MS` env var without an explicit argument.
 *
 * Pass `diagnostics` to surface the launched browser's stderr / exit
 * state in the timeout error — invaluable when Chrome crashed instead
 * of slow-booted.
 */
export const waitForDebuggerEndpoint = async (
  port: number,
  timeoutMs: number = Number(process.env.BROWSERLESS_CDP_WAIT_MS) || 15_000,
  diagnostics?: LaunchDiagnostics,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  // Last /json/list we saw, for the timeout diagnostic — lets us distinguish
  // "browser never came up" from "browser up but never exposed a target".
  let lastTargets = '<not fetched>';
  while (Date.now() < deadline) {
    try {
      // /json/version proves the DevTools HTTP server is up; it does NOT mean
      // an inspectable target exists yet. chrome-remote-interface's default-
      // target selection throws "No inspectable targets" when /json/list has
      // none, and Brave on Windows registers its initial about:blank target a
      // beat after /json/version responds. So gate on an inspectable target
      // (one carrying a webSocketDebuggerUrl), not just the version endpoint —
      // otherwise capture connects too early and intermittently fails.
      const ver = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (ver.ok) {
        const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (listRes.ok) {
          const targets = (await listRes.json()) as Array<{
            webSocketDebuggerUrl?: string;
          }>;
          if (
            Array.isArray(targets) &&
            targets.some((t) => typeof t?.webSocketDebuggerUrl === 'string')
          ) {
            return;
          }
          lastTargets = JSON.stringify(targets);
        }
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new CaptureError(
    `Browser CDP endpoint did not expose an inspectable target within ${timeoutMs}ms (last error: ${String(lastErr)})${describeLaunch(diagnostics, `Last /json/list: ${lastTargets}`)}`,
    'cdp-timeout',
  );
};

/** Browser process state + stderr tail appended to a CDP-timeout error. */
const describeLaunch = (
  diagnostics: LaunchDiagnostics | undefined,
  lastTargets: string,
): string => {
  if (!diagnostics) return '';
  const state = diagnostics.getProcessState();
  const stderr = diagnostics.getStderr().trim();
  return (
    `\nBrowser process: pid=${state.pid ?? 'unspawned'} exitCode=${state.exitCode} signal=${state.signalCode}` +
    `\nLaunch command: ${state.spawnfile} ${state.spawnargs.slice(1).join(' ')}` +
    `\n${lastTargets}` +
    (stderr
      ? `\nBrowser stderr (last ${Math.min(stderr.length, 2000)} chars):\n${stderr.slice(-2000)}`
      : '\nBrowser stderr: <empty>')
  );
};

/**
 * The pipe twin of `waitForDebuggerEndpoint`: wait until the browser answers
 * over the pipe and has an inspectable page target. Brave on Windows registers
 * its first target a beat after it starts answering, so a response alone is
 * not enough. Each probe gets a short deadline and is then re-sent, like the
 * HTTP poll it replaces: a browser can drop a command that arrives while it is
 * still starting, and waiting on that one message would time out a browser
 * that is up. Gives up early when the pipe closes — the browser exited.
 */
const PROBE_ATTEMPT_MS = 1_000;

export const waitForCdpPipe = async (
  cdp: CdpPipe,
  timeoutMs: number = Number(process.env.BROWSERLESS_CDP_WAIT_MS) || 15_000,
  diagnostics?: LaunchDiagnostics,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  let lastTargets = '<not fetched>';
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { targetInfos } = await Promise.race([
        cdp.send<{ targetInfos: Array<{ type?: string }> }>(
          'Target.getTargets',
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Target.getTargets did not answer')),
            Math.min(PROBE_ATTEMPT_MS, Math.max(deadline - Date.now(), 0)),
          );
        }),
      ]);
      if (targetInfos.some((t) => t.type === 'page')) return;
      lastTargets = JSON.stringify(targetInfos);
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && err.message.startsWith(CDP_PIPE_CLOSED)) {
        break;
      }
    } finally {
      clearTimeout(timer);
    }
    await sleep(150);
  }
  throw new CaptureError(
    `Browser CDP pipe did not expose an inspectable target within ${timeoutMs}ms (last error: ${String(lastErr)})${describeLaunch(diagnostics, `Last Target.getTargets: ${lastTargets}`)}`,
    'cdp-timeout',
  );
};

export interface LaunchOptions {
  profile: DetectedProfile;
  /**
   * Path to the `--user-data-dir` Chrome should boot against. Capture
   * paths pass a filtered temp copy; `profile launch` passes the user's
   * real path so cookies stay live. Caller owns cleanup of this dir.
   */
  userDataDir: string;
  port: number;
  /** Defaults to `true`; `profile launch` flips to `false` for an interactive window. */
  headless?: boolean;
  passwordStoreOverride?: string;
}

export interface LaunchResult {
  child: ChildProcess;
  /** Whether we defaulted Linux password-store to `basic` because we couldn't detect. */
  passwordStoreDefaulted: boolean;
  /**
   * Diagnostic accessors for CDP-timeout error messages. Wrapped in
   * thunks because exit state can change between launch and timeout.
   */
  diagnostics: LaunchDiagnostics;
}

/**
 * Chrome flags applied when spawning a temp-copy browser for capture.
 *
 * These suppress the launched browser's outbound network activity (Sync,
 * component update checks, telemetry, Safe Browsing pings, ...) so a
 * capture launch is a no-op for the user's account state. Without them,
 * the spawned browser inherits the user's full profile and immediately
 * starts hitting Brave Sync / Chrome Sync / Safe Browsing / DRM
 * component updaters / Translate API on the user's behalf — which can
 * desync session state in the user's *real* browser, manifesting as
 * "I'm randomly logged out of sites" until they restart.
 *
 * Adapted from browser-use's `CHROME_DEFAULT_ARGS`
 * (`browser_use/browser/profile.py`, MIT License,
 * https://github.com/browser-use/browser-use), which itself follows
 * Playwright's `chromiumSwitches.ts` (Apache License 2.0,
 * https://github.com/microsoft/playwright). This is the industry-standard
 * "controlled headless browser" set.
 *
 * Only applied when `opts.headless === true`. `profile launch`
 * deliberately spawns a *normal* interactive browser and skips these.
 */
const CAPTURE_LAUNCH_ARGS: string[] = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-domain-reliability',
  '--disable-datasaver-prompt',
  '--no-pings',
  '--no-service-autorun',
  '--safebrowsing-disable-auto-update',
  '--disable-external-intent-requests',
  '--metrics-recording-only',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-back-forward-cache',
  '--disable-ipc-flooding-protection',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-search-engine-choice-screen',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-infobars',
  '--disable-print-preview',
  '--disable-desktop-notifications',
  '--disable-speech-api',
  '--disable-speech-synthesis-api',
  // `--hide-crash-restore-bubble` was in browser-use's set but crashes
  // Brave 1.x headless on macOS during NSWindow restore (Brave-specific
  // AppKit interaction; Chromium upstream is unaffected). Skipped.
  '--suppress-message-center-popups',
  '--noerrdialogs',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=' +
    [
      'AcceptCHFrame',
      'AutoExpandDetailsElement',
      'AvoidUnnecessaryBeforeUnloadCheckSync',
      'CertificateTransparencyComponentUpdater',
      'DialMediaRouteProvider',
      'GlobalMediaControls',
      'HttpsUpgrades',
      'ImprovedCookieControls',
      'LazyFrameLoading',
      'MediaRouter',
      'PaintHolding',
      'Translate',
      'AutomationControlled',
      'BackForwardCache',
      'OptimizationHints',
      'CalculateNativeWinOcclusion',
      'AutofillServerCommunication',
      'CrashReporting',
      'OverscrollHistoryNavigation',
      'InfiniteSessionRestore',
    ].join(','),
];

/**
 * Spawn the user's installed browser binary against the user-data-dir.
 * The launched process inherits the user's OS-keychain entitlement
 * (macOS code signature, Windows DPAPI / Linux libsecret) so cookies
 * decrypt automatically.
 *
 * `opts.headless` controls visibility AND the network-suppression
 * flags: `true` (default) runs the browser headless with the full
 * controlled-browser arg set so spawning a copy doesn't disturb the
 * user's account state; `false` opens a real interactive window for
 * the `profile launch` flow with normal Brave/Chrome behavior.
 */
/**
 * Launch with CDP on a localhost port. Only `profile launch` uses this: it
 * exists to hand the user an endpoint for their own tools. Capture uses
 * `launchBrowserWithPipe`, because any local process can attach to a port.
 */
export const launchBrowser = (opts: LaunchOptions): Promise<LaunchResult> =>
  spawnBrowser(opts, { port: opts.port });

/** Launch for capture: CDP over a private pipe, reachable by no one else. */
export const launchBrowserWithPipe = async (
  opts: Omit<LaunchOptions, 'port'>,
): Promise<LaunchResult & { cdp: CdpPipe }> => {
  const launched = await spawnBrowser(opts, { pipe: true });
  const { stdio } = launched.child;
  return {
    ...launched,
    cdp: connectCdpPipe(stdio[3] as Writable, stdio[4] as Readable),
  };
};

const spawnBrowser = async (
  opts: Omit<LaunchOptions, 'port'>,
  debugging: { port: number } | { pipe: true },
): Promise<LaunchResult> => {
  const headless = opts.headless ?? true;
  const args = [
    'port' in debugging
      ? `--remote-debugging-port=${debugging.port}`
      : '--remote-debugging-pipe',
    `--user-data-dir=${opts.userDataDir}`,
    `--profile-directory=${opts.profile.profileDirName}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (headless) {
    args.push('--headless=new', '--disable-gpu', ...CAPTURE_LAUNCH_ARGS);
  }

  let passwordStoreDefaulted = false;
  if (process.platform === 'linux') {
    const { store, defaulted } = await resolveLinuxPasswordStore(
      opts.profile.userDataDir,
      opts.passwordStoreOverride,
    );
    args.push(`--password-store=${store}`);
    passwordStoreDefaulted = defaulted;
  }

  args.push('about:blank');

  // With the pipe, the browser reads commands on fd 3 and writes on fd 4.
  const child = spawn(opts.profile.binaryPath, args, {
    detached: false,
    stdio:
      'port' in debugging
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });

  // Drain stdout (toss) and buffer stderr (cap at 64 KB so a crash-loop
  // Chrome can't blow the heap) so callers can surface it on a CDP timeout.
  const stderrBuf: Buffer[] = [];
  let stderrBytes = 0;
  const STDERR_CAP = 64 * 1024;
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrBytes >= STDERR_CAP) return;
    stderrBuf.push(chunk);
    stderrBytes += chunk.length;
  });

  return {
    child,
    passwordStoreDefaulted,
    diagnostics: {
      getStderr: () => Buffer.concat(stderrBuf).toString('utf-8'),
      getProcessState: () => ({
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        spawnfile: child.spawnfile,
        spawnargs: child.spawnargs,
      }),
    },
  };
};

/** `webSocketDebuggerUrl` is the canonical entry point for external CDP clients. */
export interface CdpMetadata {
  Browser: string;
  webSocketDebuggerUrl: string;
}

export const fetchCdpMetadata = async (port: number): Promise<CdpMetadata> => {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) {
    throw new CaptureError(
      `CDP /json/version returned ${res.status} ${res.statusText}`,
      'cdp-metadata-invalid',
    );
  }
  const json = (await res.json()) as Partial<CdpMetadata>;
  if (
    typeof json.webSocketDebuggerUrl !== 'string' ||
    typeof json.Browser !== 'string'
  ) {
    throw new CaptureError(
      `CDP /json/version returned an unexpected payload: ${JSON.stringify(json)}`,
      'cdp-metadata-invalid',
    );
  }
  return {
    Browser: json.Browser,
    webSocketDebuggerUrl: json.webSocketDebuggerUrl,
  };
};

/** Resolve when the child exits, or after `ms`, whichever comes first. */
const waitExitOrTimeout = (child: ChildProcess, ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Absolute path of a Windows system tool. A bare name goes through the process
 * search, which checks the current directory before PATH — a `taskkill.exe`
 * planted in the folder the CLI runs from would run instead.
 */
export const windowsSystemExe = (
  exe: string,
  env: NodeJS.ProcessEnv = process.env,
): string => path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', exe);

/** Kills in flight, so a second `killBrowser` on the same child waits for it. */
const kills = new WeakMap<ChildProcess, Promise<void>>();

/**
 * Kill the entire Chrome process tree.
 *
 * On macOS / Linux SIGTERM → SIGKILL on the launcher is enough — Chrome's
 * renderer/GPU children are reaped via the parent's exit. On Windows the
 * launcher does *not* propagate kills to its children, which leaves
 * dangling chrome.exe processes holding locks on the temp user-data-dir
 * and breaking cleanup. We use `taskkill /T /F` there to terminate the
 * whole tree by PID.
 *
 * Default grace period is 2 s — long enough for Chrome to flush the
 * Cookies SQLite WAL on shutdown so session-only cookies get persisted
 * before SIGKILL. Earlier 300 ms could interrupt a flush mid-write,
 * losing in-memory session cookies (the user's "logged out of random
 * sites until restart" symptom). For non-headless `profile launch` the
 * launched browser writes back to the user's *real* dir, so a clean
 * flush matters there even more.
 *
 * Idempotent — safe to call from a `finally`. A second call while a kill is
 * in flight waits for it: an interrupt's cleanup can target the browser a
 * restart is already stopping, and returning early would let the process exit
 * before the SIGKILL lands.
 */
export const killBrowser = (
  child: ChildProcess,
  gracePeriodMs = 2_000,
): Promise<void> => {
  if (!child) return Promise.resolve();
  const inFlight = kills.get(child);
  if (inFlight) return inFlight;
  if (child.killed) return Promise.resolve();
  const kill = stopBrowser(child, gracePeriodMs);
  kills.set(child, kill);
  return kill;
};

const stopBrowser = async (
  child: ChildProcess,
  gracePeriodMs: number,
): Promise<void> => {
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    // /T = include children, /F = force. spawnSync (not spawn) so we
    // know the OS has actually torn down the tree before we return.
    // Note: Chrome renderer/utility processes use CREATE_BREAKAWAY_FROM_JOB
    // and can briefly survive after this — they self-exit within ~30s
    // when their IPC pipes detect the parent's death. Not worth more
    // aggressive cleanup logic in the CLI.
    spawnSync(
      windowsSystemExe('taskkill.exe'),
      ['/pid', String(child.pid), '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    await waitExitOrTimeout(child, gracePeriodMs);
    closeStdio(child);
    return;
  }

  child.kill('SIGTERM');
  // Race the grace period against the child's actual exit — on POSIX,
  // Chrome usually exits within ~50 ms after SIGTERM, so a fixed
  // 2 s sleep was burning ~2 s of wall clock per capture for nothing.
  await waitExitOrTimeout(child, gracePeriodMs);
  // Not `child.killed`: Node sets it as soon as SIGTERM is delivered, so a
  // browser that ignored SIGTERM would never be escalated.
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitExitOrTimeout(child, 5_000);
  }
  // Close stdio pipes and drop the child reference so Node's event loop
  // can exit even if the kernel hasn't reaped the process yet. Brave on
  // Linux takes >2 s to fully tear down its zygote tree, which was
  // hanging the CLI after capture completed.
  closeStdio(child);
  child.unref();
};

/** Every stdio stream, including the CDP pipe's fd 3 / fd 4 when present. */
const closeStdio = (child: ChildProcess): void => {
  for (const stream of child.stdio) stream?.destroy();
};

/**
 * How long a launched browser may stay silent on its pipe before capture
 * restarts it. A healthy one answers within a second or two.
 */
export const CDP_SILENCE_RESTART_MS = 10_000;

/**
 * Whether the browser sends any reply within `withinMs`. A protocol error
 * counts, and so does a closed pipe: neither is silence, and `waitForCdpPipe`
 * reports both.
 */
const answersWithin = async (
  cdp: CdpPipe,
  withinMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = await Promise.race([
      cdp.send('Target.getTargets').then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          Math.min(PROBE_ATTEMPT_MS, Math.max(deadline - Date.now(), 0)),
        );
      }),
    ]);
    clearTimeout(timer);
    if (answered) return true;
  }
  return false;
};

/**
 * Launch through `start`, and restart once if the browser stays alive but
 * never answers on its pipe for `silenceMs`. Edge on a Linux CI runner
 * occasionally came up that way, while a fresh launch answered in about a
 * second; without the restart, the capture waited out the whole readiness
 * timeout and failed. The second browser is returned whatever it does, and
 * `waitForCdpPipe` then gives it the full timeout.
 */
export const startAnsweringBrowser = async <
  L extends { child: ChildProcess; cdp: CdpPipe },
>(
  start: () => Promise<L>,
  opts: {
    silenceMs?: number;
    kill?: (child: ChildProcess) => Promise<void>;
    onRestart?: () => void;
  } = {},
): Promise<L> => {
  const first = await start();
  if (
    await answersWithin(first.cdp, opts.silenceMs ?? CDP_SILENCE_RESTART_MS)
  ) {
    return first;
  }
  if (first.child.exitCode !== null || first.child.signalCode !== null) {
    return first;
  }
  opts.onRestart?.();
  first.cdp.close();
  await (opts.kill ?? killBrowser)(first.child);
  return start();
};
