/**
 * ProfileAuthState — must match the Browserless server's contract. The CLI
 * captures this client-side and POSTs it to /profile/upload, which encrypts
 * and persists it.
 *
 * Keep this file in lockstep with the server's mirror; any drift will
 * cause the server to reject the upload as a malformed body.
 */

export interface ProfileCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  sourceScheme?: 'Unset' | 'NonSecure' | 'Secure';
  sourcePort?: number;
}

export interface ProfileIndexedDBEntry {
  // The server's mirror uses `any` here; we narrow to `unknown` on the
  // CLI side because callers only forward these values through
  // JSON.stringify into the upload body — they never *read* them, so
  // requiring a type-narrowing step at the (zero) read sites costs
  // nothing. JSON round-trips are identical to `any`.
  key: unknown;
  value: unknown;
}

export interface ProfileIndexedDBObjectStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  entries: ProfileIndexedDBEntry[];
  indexes: {
    name: string;
    keyPath: string | string[];
    unique: boolean;
    multiEntry: boolean;
  }[];
}

export interface ProfileIndexedDB {
  name: string;
  version: number;
  objectStores: ProfileIndexedDBObjectStore[];
}

export interface ProfileOriginStorage {
  origin: string;
  localStorage: Record<string, string>;
  indexedDBs?: ProfileIndexedDB[];
}

export interface ProfileAuthState {
  cookies: ProfileCookie[];
  origins: ProfileOriginStorage[];
}

/**
 * Wire contract with the server. AGENTS.md "Mirrored types" covers the merged
 * exclusion list and why a new member needs server support first; the rest is
 * visible here — no token, no server, no region.
 */
export interface ProfileCaptureSettings {
  browser?: string;
  profile?: string;
  excludeDomains?: string[];
  onlyDomains?: string[];
  keepDomains?: string[];
  autoFit?: boolean;
  /** Linux only. */
  passwordStore?: string;
  cliVersion?: string;
}

/** Per-origin failure during the CDP per-origin localStorage/IDB pass. */
export interface FailedOriginCapture {
  origin: string;
  /** Error message — best-effort, may originate from CDP or our renderer code. */
  error: string;
  /**
   * Coarse cause discriminant. Populated when the failure has a known
   * shape (e.g. the navigation timed out, the renderer crashed), absent
   * when the cause can't be inferred from the thrown error. Useful for
   * `--json` consumers and future retry logic — don't message-grep when
   * a code is available.
   */
  kind?: 'navigation-timeout' | 'cdp-disconnected' | 'unknown';
}

/** What `captureFromProfile` returns alongside the artifact. */
export interface CaptureDiagnostics {
  cookieCountBeforeExclusion: number;
  cookieCountExcluded: number;
  originCountBeforeExclusion: number;
  originCountExcluded: number;
  originCountSkippedByOnlyDomain: number;
  excludedDomains: string[];
  onlyDomains: string[];
  durationMs: number;
  /** Origins that errored mid-capture and contributed nothing to the artifact. */
  failedOrigins: FailedOriginCapture[];
}
