import fs from 'node:fs/promises';
import path from 'node:path';
import { DetectedProfile } from '../browsers/discover.js';
import {
  FailedOriginCapture,
  ProfileAuthState,
  ProfileCookie,
  ProfileIndexedDB,
  ProfileOriginStorage,
} from './types.js';
import { CaptureError } from '../errors.js';
import { errMessage } from '../utils/errors.js';
import { CdpPipe } from './cdp-pipe.js';
import {
  applyExclusions,
  originAllowedBy,
  originMatchesAny,
} from './exclusion.js';

// Client-side renderer budgets. These bound the CDP work executed inside
// the launched browser so a profile with a huge offline cache can't OOM
// the renderer mid-capture. The server applies its own (independent) caps
// when storing the uploaded artifact — if it truncates, that surfaces via
// the upload response's `diagnostics` field. Tune these on their own
// merits; there is no contract to track the server values.
const MAX_ORIGINS_PER_RUN = 50;
const MAX_IDB_DATABASES = 5;
const MAX_IDB_ENTRIES = 1_000;

/**
 * After this many consecutive transport-dead errors in the per-origin
 * loop, abort the whole capture. Higher than 1 because a single
 * ECONNREFUSED can happen during a brief CDP retry window; we only
 * trip the fail-fast when the pattern is sustained.
 */
const TRANSPORT_DEAD_THRESHOLD = 3;

/**
 * Hard deadline per origin. A normal localStorage + IDB pass finishes in
 * well under a second; anything past this is one of the known wedge
 * shapes — CDP hangs mid-attach, `Page.loadEventFired` never resolving,
 * `Target.createTarget` returning 500 under cumulative spawn pressure.
 * Without a deadline these wedges hang the whole `profile inspect` /
 * `upload` / `refresh` indefinitely. With it the origin is recorded as
 * a `failedOrigins` entry (kind: `navigation-timeout`) and the loop
 * moves on, so users get a useful diagnostic instead of a frozen CLI.
 */
const PER_ORIGIN_TIMEOUT_MS = 15_000;

/**
 * Race a promise against a timeout. On timeout, rejects with a message
 * carrying `label` and the elapsed budget. The underlying promise is
 * NOT cancelled (Node Promises aren't cancellable) — its own `finally`
 * still runs eventually, but we stop awaiting it. Acceptable trade-off
 * because the abandoned work always involves a `.close()` in `finally`
 * that releases the CDP socket.
 */
export const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);
};

/**
 * Matches the transport errors we see when the headless browser has died:
 * `CDP pipe closed` once its end of the pipe is gone (see `cdp-pipe.ts`),
 * `EPIPE` on a write that races the crash, and the socket-era shapes
 * (`ECONNREFUSED`, `socket hang up`) kept for any port-based caller.
 * Compare via `.test()` on the message because the code is embedded in it
 * rather than re-thrown verbatim.
 *
 * Exported for direct unit testing — production callers use
 * `runOriginCaptureLoop`.
 */
export const isTransportDeadError = (message: string): boolean =>
  /CDP pipe closed|ECONNREFUSED|EPIPE|socket hang up/i.test(message);

/**
 * Mirror of the server's `isPrivateCookieDomain` filter (defense in depth —
 * the server also runs this on the upload path, but enforcing it client-side
 * keeps a regression in either layer from leaking corp/intranet cookies).
 */
export const isPrivateCookieDomain = (domain: string): boolean => {
  const d = domain.startsWith('.') ? domain.slice(1) : domain;
  if (d === 'localhost' || d.endsWith('.localhost')) return true;
  if (d.endsWith('.local') || d.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(d)) return true;
  if (d === '' || d.includes(':')) return true;
  return false;
};

/**
 * True when an origin should be skipped from per-origin capture. Non-http(s)
 * schemes, anything `isPrivateCookieDomain` rejects, and unparseable origin
 * strings all drop here.
 */
export const isPrivateOrigin = (origin: string): boolean => {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    return isPrivateCookieDomain(u.hostname);
  } catch {
    return true;
  }
};

/**
 * Hostnames that serve a browser-vendor New Tab Page over public https://
 * and crash headless when we try to capture them. Currently just Edge's
 * `ntp.msn.com`: it's hardcoded as a first-party surface inside Edge, hooks
 * into native code paths for the Discover feed / Bing search widget /
 * MSN personalization that aren't wired up under `--headless=new`, and
 * tends to take the renderer (and often the whole browser process) down
 * the moment we navigate to it. Once the browser dies, the CDP socket
 * refuses every subsequent connection and the run fails.
 *
 * Chrome / Brave / Chromium use `chrome://new-tab-page` (a chrome:// scheme,
 * already dropped by `isPrivateOrigin`), so this list is Edge-flavored for
 * now. Add other vendors here if we see equivalent crashes from them.
 *
 * The origins are never going to carry useful auth state anyway — they're
 * vendor-curated content surfaces, not sites you log into.
 */
const VENDOR_NTP_HOSTS = new Set<string>(['ntp.msn.com']);

/** True when `origin`'s hostname is a known browser-vendor NTP. */
export const isVendorNtpOrigin = (origin: string): boolean => {
  try {
    return VENDOR_NTP_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/**
 * Read `<profile>/Local Storage/leveldb/` to find every origin that has any
 * stored data. We don't decode the LevelDB payload — that's what the
 * navigation step is for — we just need the origin list so we know where
 * to navigate.
 */
export const enumerateLocalStorageOrigins = async (
  profilePath: string,
): Promise<string[]> => {
  const dir = path.join(profilePath, 'Local Storage', 'leveldb');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const origins = new Set<string>();

  // LevelDB stores keys like `_https://example.com\x00\x01<key>`. We don't
  // decode the leveldb structure — too tied to Chrome's internal fork — we
  // just scan the `*.log`/`*.ldb` files for URL-shaped substrings. False
  // positives are cheap (a navigation that finds an empty localStorage).
  // Capped at ~10 MB total to keep this fast on profiles with hundreds of
  // origins.
  let bytesRead = 0;
  const BUDGET = 10 * 1024 * 1024;
  const URL_RE = /https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?/g;
  for (const entry of entries) {
    if (!entry.endsWith('.log') && !entry.endsWith('.ldb')) continue;
    if (bytesRead >= BUDGET) break;
    try {
      const buf = await fs.readFile(path.join(dir, entry));
      bytesRead += buf.byteLength;
      const text = buf.toString('latin1');
      for (const match of text.matchAll(URL_RE)) {
        try {
          const u = new URL(match[0]);
          if (
            (u.protocol === 'https:' || u.protocol === 'http:') &&
            !isPrivateCookieDomain(u.hostname) &&
            !VENDOR_NTP_HOSTS.has(u.hostname)
          ) {
            origins.add(u.origin);
          }
        } catch {
          // skip malformed
        }
      }
    } catch {
      // skip unreadable file
    }
  }

  return [...origins];
};

/** Project a CDP `Network.Cookie` shape onto our `ProfileCookie`. */
export const cookieFromCdp = (c: any): ProfileCookie => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  expires: typeof c.expires === 'number' ? c.expires : -1,
  size: c.size,
  httpOnly: !!c.httpOnly,
  secure: !!c.secure,
  session: !!c.session,
  ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  ...(c.sourceScheme ? { sourceScheme: c.sourceScheme } : {}),
  ...(c.sourcePort ? { sourcePort: c.sourcePort } : {}),
});

/**
 * Deadline for the one `Storage.getCookies` round trip. It runs before the
 * per-origin loop and its timeouts, so a browser that keeps the pipe open but
 * stops answering would otherwise hang the capture before cleanup can run.
 */
export const COOKIE_READ_TIMEOUT_MS = 30_000;

const captureCookies = async (cdp: CdpPipe): Promise<ProfileCookie[]> => {
  const { cookies } = await withTimeout(
    cdp.send('Storage.getCookies'),
    COOKIE_READ_TIMEOUT_MS,
    'Storage.getCookies',
  ).catch((err: unknown) => {
    throw new CaptureError(
      `Reading cookies from the headless browser failed: ${errMessage(err)}`,
      'cdp-timeout',
    );
  });
  return cookies
    .filter((c: any) => !isPrivateCookieDomain(c.domain))
    .map(cookieFromCdp);
};

interface OriginCaptureCtx {
  cdp: CdpPipe;
  origin: string;
}

const stubHtml = Buffer.from('<html></html>').toString('base64');

/**
 * Open a fresh target, attach a flattened CDP session, navigate to `origin/` via a
 * Fetch.requestPaused stub (we never actually hit the network), then read
 * localStorage and enumerate IndexedDB. Mirrors the server's
 * `captureAuthState` per-origin flow.
 */
const captureOrigin = async (
  ctx: OriginCaptureCtx,
): Promise<ProfileOriginStorage | null> => {
  const { cdp } = ctx;
  const { targetId } = await cdp.send<{ targetId?: string }>(
    'Target.createTarget',
    { url: 'about:blank' },
  );
  if (!targetId) return null;

  let sessionId: string | undefined;
  let stopIntercepting = (): void => undefined;
  try {
    ({ sessionId } = await cdp.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId, flatten: true },
    ));
    const tab = cdp.session(sessionId);

    await tab.send('Page.enable');
    await tab.send('Network.enable');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

    const navigationUrls = new Set<string>([`${ctx.origin}/`]);
    stopIntercepting = tab.on('Fetch.requestPaused', (params: any) => {
      const { requestId, request } = params;
      if (navigationUrls.has(request.url)) {
        navigationUrls.delete(request.url);
        tab
          .send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
            body: stubHtml,
          })
          .catch(() => undefined);
      } else {
        tab
          .send('Fetch.failRequest', {
            requestId,
            errorReason: 'BlockedByClient',
          })
          .catch(() => undefined);
      }
    });

    // Subscribe before navigating: the stub page can finish loading before
    // `Page.navigate` even returns.
    // Handled up front: if navigation throws, this wait is abandoned and later
    // rejects when the pipe closes, which must not surface as unhandled.
    const loaded = tab.once('Page.loadEventFired').catch(() => undefined);
    await tab.send('Page.navigate', { url: `${ctx.origin}/` });
    await loaded;

    const lsResult = await tab.send('Runtime.evaluate', {
      expression: `
        (() => {
          const out = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            out[key] = localStorage.getItem(key);
          }
          return JSON.stringify(out);
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    });
    const localStorage: Record<string, string> = lsResult?.result?.value
      ? JSON.parse(lsResult.result.value)
      : {};

    const idbResult = await tab.send('Runtime.evaluate', {
      expression: `
        (async (MAX_DBS, MAX_ENTRIES) => {
          if (typeof indexedDB.databases !== 'function') return [];
          const dbInfos = await indexedDB.databases();
          const out = [];
          for (const { name, version } of dbInfos.slice(0, MAX_DBS)) {
            if (!name) continue;
            try {
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(name, version);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                req.onupgradeneeded = () => {};
              });
              const stores = [];
              for (const storeName of db.objectStoreNames) {
                try {
                  const tx = db.transaction(storeName, 'readonly');
                  const store = tx.objectStore(storeName);
                  const indexes = [];
                  for (const indexName of store.indexNames) {
                    const idx = store.index(indexName);
                    indexes.push({
                      name: idx.name, keyPath: idx.keyPath,
                      unique: idx.unique, multiEntry: idx.multiEntry,
                    });
                  }
                  const [keys, values] = await Promise.all([
                    new Promise((res, rej) => {
                      const r = store.getAllKeys(undefined, MAX_ENTRIES);
                      r.onsuccess = () => res(r.result);
                      r.onerror = () => rej(r.error);
                    }),
                    new Promise((res, rej) => {
                      const r = store.getAll(undefined, MAX_ENTRIES);
                      r.onsuccess = () => res(r.result);
                      r.onerror = () => rej(r.error);
                    }),
                  ]);
                  const entries = keys.map((k, i) => ({ key: k, value: values[i] }));
                  stores.push({
                    name: storeName, keyPath: store.keyPath,
                    autoIncrement: store.autoIncrement, entries, indexes,
                  });
                } catch {}
              }
              db.close();
              out.push({ name, version, objectStores: stores });
            } catch {}
          }
          return JSON.stringify(out);
        })(${MAX_IDB_DATABASES}, ${MAX_IDB_ENTRIES})
      `,
      returnByValue: true,
      awaitPromise: true,
    });
    const indexedDBs: ProfileIndexedDB[] = idbResult?.result?.value
      ? JSON.parse(idbResult.result.value)
      : [];

    if (Object.keys(localStorage).length === 0 && indexedDBs.length === 0) {
      return null;
    }

    return {
      origin: ctx.origin,
      localStorage,
      ...(indexedDBs.length > 0 ? { indexedDBs } : {}),
    };
  } finally {
    stopIntercepting();
    if (sessionId) {
      const tab = cdp.session(sessionId);
      await tab.send('Fetch.disable').catch(() => undefined);
      await tab.send('Network.disable').catch(() => undefined);
      await cdp
        .send('Target.detachFromTarget', { sessionId })
        .catch(() => undefined);
    }
    // The tab may already be gone.
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
};

export interface CapturedOverCdp {
  state: ProfileAuthState;
  /** True if we hit the origin cap and skipped the rest. */
  capHit: boolean;
  /** Total cookies returned by Storage.getCookies, before exclusion. */
  cookieCountTotal: number;
  /** Cookies dropped by the post-capture exclusion filter. */
  cookieCountExcluded: number;
  /** Candidate origins (post-private filter) that match the exclusion list. */
  originCountSkippedByExclusion: number;
  /** Candidate origins skipped pre-navigation because they didn't match --only-domain. */
  originCountSkippedByOnlyDomain: number;
  /** Per-origin failures during the navigate / evaluate / IDB enumeration step. */
  failedOrigins: FailedOriginCapture[];
}

/** Outcome of {@link runOriginCaptureLoop}. */
export interface OriginLoopResult {
  origins: ProfileOriginStorage[];
  failedOrigins: FailedOriginCapture[];
  /** True if we hit the origin cap and skipped the rest. */
  capHit: boolean;
  /** Origins skipped because they matched the exclusion list. */
  originCountSkippedByExclusion: number;
  /** Origins skipped because they didn't match the --only-domain allowlist. */
  originCountSkippedByOnlyDomain: number;
}

/**
 * Emitted once before each origin attempt (i.e. only for origins that
 * survive the pre-filters and we'll actually run `doCapture` against).
 * Lets a CLI surface a live "origin N/M" indicator during the slow
 * per-origin pass without coupling the capture loop to stderr.
 */
export type OriginProgressEvent = {
  /** 1-indexed count of origins we've started capturing in this run. */
  attempted: number;
  /**
   * Upper-bound estimate of how many origins we'll attempt. Equals the
   * count of candidate origins minus private + exclusion-listed ones at
   * iteration time. The actual `attempted` may be less if we hit the
   * per-run origin cap mid-loop.
   */
  total: number;
  /** The origin URL currently being captured. */
  origin: string;
};

/**
 * Drive per-origin localStorage / IndexedDB capture across a list of
 * candidate origins, with `doCapture` injected so this loop can be
 * exercised in isolation. Two failure shapes throw {@link CaptureError}
 * instead of returning a degraded result:
 *
 *   1. **Headless browser crashed mid-run** — once we see
 *      {@link TRANSPORT_DEAD_THRESHOLD} consecutive ECONNREFUSED / EPIPE
 *      errors from `doCapture`, the browser is gone and the next N origin
 *      attempts would just emit identical noise. Bail with a clear
 *      "browser crashed" message instead.
 *
 *   2. **All attempted origins failed** — if every navigated origin
 *      errored and produced zero successes, surfacing a 0/0 summary
 *      would falsely imply the profile is empty. Throw so the upload
 *      path can't ship an empty artifact.
 *
 * Origins skipped pre-navigation (private hosts, exclusion-list matches,
 * cap reached) do NOT count toward "attempted" — only origins we actually
 * called `doCapture` for.
 *
 * Exported for direct unit testing — production callers use
 * `captureViaCdp`.
 */
export const runOriginCaptureLoop = async (
  candidateOrigins: string[],
  excludedDomains: string[],
  doCapture: (origin: string) => Promise<ProfileOriginStorage | null>,
  onProgress?: (event: OriginProgressEvent) => void,
  onlyDomains: string[] = [],
): Promise<OriginLoopResult> => {
  const origins: ProfileOriginStorage[] = [];
  const failedOrigins: FailedOriginCapture[] = [];
  let capHit = false;
  let originCountSkippedByExclusion = 0;
  let originCountSkippedByOnlyDomain = 0;
  let consecutiveTransportDeadFailures = 0;
  let attempted = 0;

  // Cheap pre-pass: how many origins will survive the filters? Used only
  // to render a useful progress denominator. Stays an upper bound when
  // the per-run cap trims the tail.
  const attemptableTotal = candidateOrigins
    .filter((o) => !isPrivateOrigin(o))
    .filter((o) => !isVendorNtpOrigin(o))
    .filter((o) => !originMatchesAny(o, excludedDomains))
    .filter(
      (o) => onlyDomains.length === 0 || originAllowedBy(o, onlyDomains),
    ).length;
  const progressBudget = Math.min(attemptableTotal, MAX_ORIGINS_PER_RUN);

  for (const origin of candidateOrigins) {
    // Cap on *attempts* (not on successful captures). MAX_ORIGINS_PER_RUN
    // is a renderer-work budget — each attempt costs a Target.createTarget
    // + Page.navigate + Runtime.evaluate round-trip whether or not the
    // origin ends up having storage to keep. Capping on successes would
    // let a profile with lots of empty-storage origins burn unbounded
    // CDP cycles, and (visibly) makes the progress counter overshoot
    // the denominator (e.g. `70/50`).
    if (attempted >= MAX_ORIGINS_PER_RUN) {
      capHit = true;
      break;
    }
    if (isPrivateOrigin(origin)) continue;
    // Skip silently — these never reach `captureOrigin`, so the renderer
    // never tries to navigate to them. See `VENDOR_NTP_HOSTS` for why.
    if (isVendorNtpOrigin(origin)) continue;
    if (originMatchesAny(origin, excludedDomains)) {
      originCountSkippedByExclusion++;
      continue;
    }
    // Skip BEFORE bumping `attempted` — otherwise the per-run cap can be
    // consumed by origins that would have been dropped post-capture.
    if (onlyDomains.length > 0 && !originAllowedBy(origin, onlyDomains)) {
      originCountSkippedByOnlyDomain++;
      continue;
    }
    attempted++;
    onProgress?.({ attempted, total: progressBudget, origin });
    try {
      const captured = await doCapture(origin);
      if (captured) origins.push(captured);
      consecutiveTransportDeadFailures = 0;
    } catch (err) {
      // One origin failing shouldn't kill the whole run — collect the
      // error so the caller can surface a summary on stderr. `kind` is
      // a best-effort coarse discriminant — message-sniff for known
      // shapes, fall through to 'unknown' otherwise.
      const message = errMessage(err);

      if (isTransportDeadError(message)) {
        consecutiveTransportDeadFailures++;
        if (consecutiveTransportDeadFailures >= TRANSPORT_DEAD_THRESHOLD) {
          throw new CaptureError(
            `Headless browser appears to have crashed mid-capture — ${TRANSPORT_DEAD_THRESHOLD} consecutive transport errors on the CDP connection. Last failure on "${origin}": ${message}. Retry the capture; if it persists, try a smaller profile or a different --password-store value.`,
            'browser-crashed-during-capture',
          );
        }
      } else {
        consecutiveTransportDeadFailures = 0;
      }

      let kind: FailedOriginCapture['kind'] = 'unknown';
      const lowered = message.toLowerCase();
      if (lowered.includes('timeout') || lowered.includes('timed out')) {
        kind = 'navigation-timeout';
      } else if (
        lowered.includes('websocket') ||
        lowered.includes('not connected') ||
        lowered.includes('connection closed') ||
        lowered.includes('pipe closed')
      ) {
        kind = 'cdp-disconnected';
      }
      failedOrigins.push({ origin, error: message, kind });
    }
  }

  // Every navigated origin failed AND there were no successes — surface
  // this as an error rather than letting the caller upload an empty
  // artifact under a "captured 0/0" banner.
  if (origins.length === 0 && failedOrigins.length > 0) {
    const sample = failedOrigins
      .slice(0, 3)
      .map((f) => `${f.origin}: ${f.error}`)
      .join('; ');
    const overflow =
      failedOrigins.length > 3 ? ` (+${failedOrigins.length - 3} more)` : '';
    throw new CaptureError(
      `All ${failedOrigins.length} attempted origin(s) failed to capture; nothing usable was produced. Sample: ${sample}${overflow}`,
      'all-origins-failed',
    );
  }

  return {
    origins,
    failedOrigins,
    capHit,
    originCountSkippedByExclusion,
    originCountSkippedByOnlyDomain,
  };
};

/**
 * Drive cookies + per-origin localStorage / IndexedDB capture against the
 * already-launched browser over its CDP pipe. The browser must be live; this
 * function does not start or stop it. Origins matching `excludedDomains`
 * are skipped before navigation so we don't burn a tab on an origin we'd
 * drop afterwards; cookies are filtered post-Storage.getCookies because
 * there's no per-cookie streaming API.
 */
export const captureViaCdp = async (
  profile: DetectedProfile,
  cdp: CdpPipe,
  excludedDomains: string[] = [],
  onProgress?: (event: OriginProgressEvent) => void,
  onlyDomains: string[] = [],
): Promise<CapturedOverCdp> => {
  const allCookies = await captureCookies(cdp);
  const allOrigins = await enumerateLocalStorageOrigins(profile.profilePath);

  const loop = await runOriginCaptureLoop(
    allOrigins,
    excludedDomains,
    (origin) =>
      withTimeout(
        captureOrigin({ cdp, origin }),
        PER_ORIGIN_TIMEOUT_MS,
        `per-origin capture of ${origin}`,
      ),
    onProgress,
    onlyDomains,
  );

  // Cookie filter runs post-capture (Storage.getCookies is one round trip).
  // Origins were already filtered pre-navigation; passing them through
  // applyExclusions again is a cheap no-op.
  const filtered = applyExclusions(
    { cookies: allCookies, origins: loop.origins },
    excludedDomains,
  );

  return {
    state: filtered.state,
    capHit: loop.capHit,
    cookieCountTotal: allCookies.length,
    cookieCountExcluded: allCookies.length - filtered.state.cookies.length,
    originCountSkippedByExclusion: loop.originCountSkippedByExclusion,
    originCountSkippedByOnlyDomain: loop.originCountSkippedByOnlyDomain,
    failedOrigins: loop.failedOrigins,
  };
};

/** Re-export for callers building a CaptureError on launch failure. */
export { CaptureError };
