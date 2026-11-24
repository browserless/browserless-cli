/**
 * In-process record of the API token resolved during this CLI invocation,
 * together with the server URL it was resolved for.
 *
 * Telemetry attribution reuses whatever token the command already resolved for
 * its own API call (set by `resolveToken`), rather than resolving one itself:
 * a fresh resolution could hit the OS keychain and trigger an unlock prompt,
 * which telemetry must never cause.
 *
 * The recorded server is the *gate*, not the destination: analytics events are
 * always POSTed to the account API (api.browserless.io), but only when the
 * token was resolved against a known Browserless cloud region. A token
 * resolved against a self-hosted server is dropped — it's a credential to the
 * user's own deployment, never forwarded to the cloud API.
 *
 * `auth login` doesn't go through `resolveToken`, so it calls `recordToken`
 * itself after validating the token — it's tracked like any other
 * authenticated command. Commands that never resolve a token (local-only ones
 * like `config` and offline `inspect`) record nothing and aren't tracked.
 */
export interface RecordedToken {
  readonly token: string;
  /** The server URL the token was resolved for. */
  readonly server: string;
}

let recorded: RecordedToken | undefined;

// Object parameter (not positional) so a token/server mix-up can't typecheck.
export const recordToken = (entry: RecordedToken): void => {
  recorded = entry;
};

export const getRecordedToken = (): RecordedToken | undefined => recorded;

export const _resetRecordedTokenForTests = (): void => {
  recorded = undefined;
};
