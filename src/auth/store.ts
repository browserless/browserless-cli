import { readConfig, updateConfig } from '../config/store.js';
import { DEFAULT_SERVER, TokenStorageMode } from '../config/schema.js';
import {
  deleteFromKeychain,
  readFromKeychain,
  writeToKeychain,
} from './keychain.js';
import { PreconditionError } from '../errors.js';
import { regionToServerUrl } from '../regions.js';
import { recordToken } from '../telemetry/token-cache.js';
import { assertSecureServerUrl } from './server-url.js';

export interface ResolvedToken {
  token: string;
  /** Where the token came from — used by `auth status`. */
  source: 'flag' | 'env' | 'keychain' | 'file';
}

const ENV_VAR = 'BROWSERLESS_TOKEN';

export interface ServerOverrides {
  /** `--server <url>` flag value, if passed. */
  server?: string;
  /** `--region <code>` flag value, if passed. */
  region?: string;
}

/**
 * Resolve the active server URL. Precedence, most-specific first:
 *   1. `--region <code>` flag
 *   2. `--server <url>` flag
 *   3. `region` config
 *   4. `server` config
 *   5. DEFAULT_SERVER
 *
 * Flags trump config; specifying both `--region` and `--server` together
 * is a UsageError because the intent is ambiguous. Having both `region`
 * and `server` set in config is also rejected up front to avoid silent
 * surprises later.
 *
 * Accepts a bare string for backwards compatibility with existing
 * call-sites that pass just the server override.
 */
export const resolveServer = async (
  overrideOrOpts?: string | ServerOverrides,
): Promise<string> => {
  const flagServer =
    typeof overrideOrOpts === 'string'
      ? overrideOrOpts
      : overrideOrOpts?.server;
  const flagRegion =
    typeof overrideOrOpts === 'string' ? undefined : overrideOrOpts?.region;

  if (flagRegion && flagServer) {
    throw new PreconditionError(
      '--region and --server are mutually exclusive — pass one or the other.',
      'server-region-conflict',
    );
  }
  if (flagRegion) return regionToServerUrl(flagRegion);
  if (flagServer) return assertSecureServerUrl(flagServer);

  const config = await readConfig();
  if (config.region && config.server) {
    throw new PreconditionError(
      `Both "region" (${config.region}) and "server" (${config.server}) are set in ~/.browserless/config.json — ` +
        `unset one with \`browserless config unset region\` or \`browserless config unset server\`.`,
      'server-region-conflict',
    );
  }
  if (config.region) return regionToServerUrl(config.region);
  return assertSecureServerUrl(config.server ?? DEFAULT_SERVER);
};

/**
 * Token resolution order: flag > env > keychain > file.
 * The keychain entry is keyed by server URL so one machine can hold
 * credentials for production-sfo.browserless.io and a self-hosted
 * deployment side by side.
 *
 * A keychain read that fails (`op-failed`) is a hard error, not a
 * silent fall-through. Otherwise a locked keychain would present as
 * "no entry exists" and the user would lose access to a stored token
 * without ever being told why.
 */
export const resolveToken = async (params: {
  flag?: string;
  server: string;
}): Promise<ResolvedToken> => {
  if (params.flag) {
    recordToken({ token: params.flag, server: params.server });
    return { token: params.flag, source: 'flag' };
  }

  const fromEnv = process.env[ENV_VAR];
  if (fromEnv) {
    recordToken({ token: fromEnv, server: params.server });
    return { token: fromEnv, source: 'env' };
  }

  const fromKeychain = await readFromKeychain(params.server);
  if (fromKeychain.ok) {
    if (fromKeychain.value !== null) {
      recordToken({ token: fromKeychain.value, server: params.server });
      return { token: fromKeychain.value, source: 'keychain' };
    }
    // ok: true, value: null → keychain reachable, no entry — fall through
  } else if (fromKeychain.reason === 'op-failed') {
    throw new PreconditionError(
      `Keychain is available but read failed: ${fromKeychain.error}. ` +
        `Retry, or set BROWSERLESS_DISABLE_KEYCHAIN=1 to bypass and use the plaintext fallback at ~/.browserless/config.json.`,
      'keychain-read-failed',
    );
  }

  const config = await readConfig();
  if (config.api_key) {
    recordToken({ token: config.api_key, server: params.server });
    return { token: config.api_key, source: 'file' };
  }

  throw new PreconditionError(
    `No API token configured. Run \`browserless auth login\` to set one.`,
    'no-token',
  );
};

/**
 * Persist a token after `auth login`.
 *
 * Keychain path: when the OS keychain is reachable, write there and clear
 * any old plaintext fallback. Falling back to plaintext when the keychain
 * is *present* but the write *failed* would silently downgrade storage
 * security on a transient unlock prompt — instead we surface the
 * underlying error so the user can retry or pass
 * BROWSERLESS_DISABLE_KEYCHAIN=1 deliberately.
 */
export const persistToken = async (params: {
  server: string;
  token: string;
}): Promise<{ mode: TokenStorageMode; warning?: string }> => {
  const result = await writeToKeychain(params.server, params.token);
  if (result.ok) {
    await updateConfig((c) => {
      c.token_storage = 'keychain';
      delete c.api_key;
    });
    return { mode: 'keychain' };
  }
  if (result.reason === 'op-failed') {
    throw new PreconditionError(
      `Keychain is available but write failed: ${result.error}. ` +
        `Retry, or set BROWSERLESS_DISABLE_KEYCHAIN=1 to store the token in plaintext at ~/.browserless/config.json instead.`,
      'keychain-write-failed',
    );
  }
  await updateConfig((c) => {
    c.token_storage = 'file';
    c.api_key = params.token;
  });
  return {
    mode: 'file',
    warning:
      'Token stored in plaintext at ~/.browserless/config.json — keychain unavailable on this system.',
  };
};

/**
 * Clear stored credentials for `auth logout`.
 *
 * Both the keychain entry (if any) and the plaintext fallback must be
 * cleared — if either persists, `auth status` will resurrect a "logged
 * in" state on the next run. A *missing* keychain entry is fine; an
 * actual delete failure must surface so the user knows their token
 * survived.
 */
export const clearToken = async (server: string): Promise<void> => {
  const result = await deleteFromKeychain(server);
  if (!result.ok && result.reason === 'op-failed') {
    throw new PreconditionError(
      `Could not delete the keychain entry for ${server}: ${result.error}. ` +
        `The token may still be stored — fix the keychain access and re-run \`browserless auth logout\`.`,
      'keychain-delete-failed',
    );
  }
  await updateConfig((c) => {
    delete c.api_key;
    delete c.token_storage;
  });
};

export const getTokenStorageMode = async (): Promise<TokenStorageMode> => {
  const config = await readConfig();
  return config.token_storage ?? 'none';
};
