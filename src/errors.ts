/**
 * Errors a command can throw to halt execution and produce a clean,
 * user-targeted message at the top-level error handler in cli.ts.
 *
 * Anything that isn't a `UserFacingError` is treated as an internal bug —
 * its full stack is printed.
 */
export class UserFacingError extends Error {
  exitCode: number = 1;
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

/**
 * The user passed bad arguments — wrong browser key, missing required flag,
 * unknown profile, etc. Exits 2.
 */
export type UsageCode =
  | 'unknown-browser'
  | 'browser-has-no-profiles'
  | 'local-profile-not-found'
  | 'invalid-cloud-profile-name'
  | 'cloud-profile-not-found'
  | 'local-profile-ambiguous'
  | 'invalid-only-domain'
  | 'missing-capture-settings'
  | 'invalid-integer-flag'
  | 'invalid-server-url'
  | 'unsupported-server-scheme'
  | 'unknown-region'
  | 'missing-required-flag';

export class UsageError extends UserFacingError {
  constructor(
    message: string,
    public readonly code?: UsageCode,
  ) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

/**
 * Stable identifiers for individual PreconditionError causes. Use these
 * instead of message-grepping when behaviour needs to branch on cause
 * (tests, `--json` output, future error reporters). `undefined` is fine
 * for one-off cases that don't need a programmatic discriminant yet.
 */
export type PreconditionCode =
  | 'no-token'
  | 'invalid-token'
  | 'terms-not-accepted'
  | 'server-region-conflict'
  | 'insecure-server-url'
  | 'unknown-region'
  | 'keychain-read-failed'
  | 'keychain-write-failed'
  | 'keychain-delete-failed'
  | 'invalid-config-file'
  | 'invalid-custom-browsers-file'
  | 'profile-busy';

/** A precondition failed (no token configured, terms not accepted, ...). Exits 3. */
export class PreconditionError extends UserFacingError {
  constructor(
    message: string,
    public readonly code?: PreconditionCode,
  ) {
    super(message);
    this.name = 'PreconditionError';
    this.exitCode = 3;
  }
}

/**
 * Stable identifiers for CaptureError causes. Same rationale as
 * `PreconditionCode` — let callers programmatically discriminate without
 * pattern-matching error messages.
 */
export type CaptureCode =
  | 'profile-copy-failed'
  | 'profile-file-locked'
  | 'browser-launch-failed'
  | 'cdp-timeout'
  | 'cdp-metadata-invalid'
  | 'browser-crashed-during-capture'
  | 'all-origins-failed';

/** The local capture pipeline failed (browser launch, CDP, copy). Exits 4. */
export class CaptureError extends UserFacingError {
  constructor(
    message: string,
    public readonly code?: CaptureCode,
  ) {
    super(message);
    this.name = 'CaptureError';
    this.exitCode = 4;
  }
}

export type ApiErrorCode =
  | 'request-timeout'
  | 'network-unreachable'
  | 'response-read-failed'
  | 'response-too-large'
  | 'invalid-response'
  | 'capture-settings-rejected'
  | 'websocket-failed'
  | 'websocket-not-open'
  | 'agent-session-error';

/** The Browserless server returned a non-2xx response. Exits 5. */
export class ApiError extends UserFacingError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
    public readonly code?: ApiErrorCode,
  ) {
    super(message);
    this.name = 'ApiError';
    this.exitCode = 5;
  }
}

export const exitCodeFor = (err: unknown): number =>
  err instanceof UserFacingError ? err.exitCode : 1;

/**
 * Extract a stable error `code` string for telemetry / error reporting.
 *
 * Only some errors carry one — `PreconditionError` / `CaptureError` (where
 * `code` is a declared-but-optional property, so it's always *present* and
 * often `undefined`) and Node `ErrnoException`s (`ENOENT`, `ECONNREFUSED`, …).
 * Returns it only when it's a non-empty string, else `undefined` — an empty
 * `error_code` is noise in analytics.
 */
export const errorCodeOf = (err: unknown): string | undefined => {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }
  return undefined;
};

export type ErrorCategory =
  'usage' | 'precondition' | 'capture' | 'api' | 'network' | 'internal';

export interface ErrorTelemetry {
  errorName?: string;
  errorCode: string;
  errorCategory: ErrorCategory;
  httpStatus?: number;
}

const HTTP_ERROR_CODES: Record<number, string> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  413: 'payload-too-large',
  429: 'rate-limited',
};

const NETWORK_CODES: ReadonlySet<ApiErrorCode> = new Set([
  'request-timeout',
  'network-unreachable',
  'response-read-failed',
  'websocket-failed',
  'websocket-not-open',
]);

export const errorTelemetryOf = (err: unknown): ErrorTelemetry => {
  let errorCategory: ErrorCategory = 'internal';
  let errorCode = 'unknown';
  let httpStatus: number | undefined;
  if (err instanceof UsageError) {
    errorCategory = 'usage';
    errorCode = err.code ?? 'unknown';
  } else if (err instanceof PreconditionError) {
    errorCategory = 'precondition';
    errorCode = err.code ?? 'unknown';
  } else if (err instanceof CaptureError) {
    errorCategory = 'capture';
    errorCode = err.code ?? 'unknown';
  } else if (err instanceof ApiError) {
    httpStatus = err.status > 0 ? err.status : undefined;
    errorCategory = (err.code ? NETWORK_CODES.has(err.code) : err.status === 0)
      ? 'network'
      : 'api';
    errorCode =
      err.code ??
      HTTP_ERROR_CODES[err.status] ??
      (err.status >= 400 && err.status <= 499
        ? 'client-error'
        : err.status >= 500 && err.status <= 599
          ? 'server-error'
          : err.status === 0
            ? 'unknown'
            : 'http-error');
  } else if (!(err instanceof UserFacingError)) {
    errorCode = errorCodeOf(err) ?? 'unknown';
  }
  return {
    errorName: err instanceof Error ? err.name : undefined,
    errorCode: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(errorCode)
      ? errorCode
      : 'unknown',
    errorCategory,
    httpStatus,
  };
};
