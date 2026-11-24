import { UsageError } from '../errors.js';
import { isKnownRegion, KNOWN_REGIONS } from '../regions.js';

/**
 * Default Browserless server. Override via `browserless config set server`,
 * `browserless config set region <sfo|lon|ams>`, or the equivalent
 * `--server <url>` / `--region <code>` flags per invocation.
 */
export const DEFAULT_SERVER = 'https://production-sfo.browserless.io';

/**
 * Default re-prompt window for the liability disclaimer. The CLI suppresses
 * the prompt for `terms_ttl_days` after each acceptance.
 */
export const DEFAULT_TERMS_TTL_DAYS = 7;

export type TokenStorageMode = 'keychain' | 'file' | 'none';

export interface ConfigShape {
  /** Server base URL — user-managed. Mutually exclusive with `region`. */
  server?: string;

  /**
   * Region code (sfo / lon / ams) — user-managed shorthand for the
   * production server URL. Mutually exclusive with `server`; when both
   * are set, `region` wins and a one-time warning is emitted.
   */
  region?: string;

  /** Liability re-prompt TTL in days — user-managed. */
  terms_ttl_days?: number;

  /**
   * Opt-out switch for CLI usage analytics — user-managed.
   * Defaults to enabled; set `false` to disable. Also overridable per-run
   * via `BROWSERLESS_TELEMETRY_DISABLED=1` or the standard `DO_NOT_TRACK=1`.
   */
  telemetry?: boolean;

  /** Permanent domain exclusion list — managed via `profile exclude`. */
  excluded_domains?: string[];

  /** ISO timestamp of the last accepted disclaimer. CLI-managed. */
  accepted_terms_at?: string;

  /** Where the API token currently lives. CLI-managed. */
  token_storage?: TokenStorageMode;

  /** Plaintext token — only present when keychain is unavailable. CLI-managed. */
  api_key?: string;
}

/**
 * Each KEY_SPECS entry must explicitly mark `sensitive`. Omitting it
 * would be ambiguous and risky — a new sensitive key (`refresh_token`,
 * `webhook_secret`, ...) added without the flag would silently print
 * plaintext to stdout via `config get`. Making it required forces a
 * deliberate decision at every new key.
 */
interface ScalarKeySpec {
  kind: 'scalar';
  parse: (raw: string) => unknown;
  /** Redact value behind --show-sensitive flag when printing via `config get`. */
  sensitive: boolean;
}

interface ListKeySpec {
  kind: 'list';
  manageHint: string;
  sensitive: boolean;
}

interface CliManagedKeySpec {
  kind: 'cli-managed';
  manageHint: string;
  sensitive: boolean;
}

type KeySpec = ScalarKeySpec | ListKeySpec | CliManagedKeySpec;

/**
 * Per-key metadata for `config get/set/unset`. Drives validation:
 *  - scalar: settable via `config set <key> <value>`; `parse` coerces the
 *    string argument into the stored type.
 *  - list: settable only via the dedicated subcommand (e.g. `profile exclude`).
 *  - cli-managed: written by the CLI itself; not user-editable.
 */
const KEY_SPECS: Record<keyof ConfigShape, KeySpec> = {
  server: {
    kind: 'scalar',
    sensitive: false,
    parse: (raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new UsageError(`server must be a valid URL (got "${raw}")`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UsageError(
          `server must use https:// (got "${url.protocol}")`,
        );
      }
      return raw;
    },
  },
  region: {
    kind: 'scalar',
    sensitive: false,
    parse: (raw) => {
      if (!isKnownRegion(raw)) {
        throw new UsageError(
          `region must be one of: ${KNOWN_REGIONS.join(', ')} (got "${raw}"). ` +
            `For self-hosted or staging, use \`config set server <url>\` instead.`,
        );
      }
      return raw;
    },
  },
  terms_ttl_days: {
    kind: 'scalar',
    sensitive: false,
    parse: (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw new UsageError(
          `terms_ttl_days must be a non-negative integer (got "${raw}")`,
        );
      }
      return n;
    },
  },
  telemetry: {
    kind: 'scalar',
    sensitive: false,
    parse: (raw) => {
      const v = raw.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'off'].includes(v)) return false;
      throw new UsageError(
        `telemetry must be a boolean (true/false) (got "${raw}")`,
      );
    },
  },
  excluded_domains: {
    kind: 'list',
    manageHint: '`browserless profile exclude add/rm/list`',
    sensitive: false,
  },
  accepted_terms_at: {
    kind: 'cli-managed',
    manageHint: 'set automatically when you accept the disclaimer',
    sensitive: false,
  },
  token_storage: {
    kind: 'cli-managed',
    manageHint: 'set automatically by `browserless auth login`',
    sensitive: false,
  },
  api_key: {
    kind: 'cli-managed',
    manageHint: 'managed by `browserless auth login` / `auth logout`',
    sensitive: true,
  },
};

/** True if `config get <key>` should redact the value by default. */
export const isSensitiveKey = (key: keyof ConfigShape): boolean =>
  KEY_SPECS[key].sensitive;

export const allConfigKeys = (): (keyof ConfigShape)[] =>
  Object.keys(KEY_SPECS) as (keyof ConfigShape)[];

export const isKnownKey = (key: string): key is keyof ConfigShape =>
  Object.prototype.hasOwnProperty.call(KEY_SPECS, key);

/**
 * Validate a `config set` request. Returns the parsed value to store, or
 * throws a UsageError pointing the user to the right command.
 */
export const validateScalarSet = (key: string, raw: string): unknown => {
  if (!isKnownKey(key)) {
    throw new UsageError(
      `Unknown config key "${key}". Known keys: ${allConfigKeys().join(', ')}.`,
    );
  }
  const spec = KEY_SPECS[key];
  if (spec.kind === 'list') {
    throw new UsageError(
      `"${key}" is a list. Manage it via ${spec.manageHint} — not via \`config set\`.`,
    );
  }
  if (spec.kind === 'cli-managed') {
    throw new UsageError(
      `"${key}" is managed by the CLI (${spec.manageHint}). Editing it directly is not supported.`,
    );
  }
  return spec.parse(raw);
};

/** Validate a `config unset` request — same restrictions as set. */
export const validateUnset = (key: string): keyof ConfigShape => {
  if (!isKnownKey(key)) {
    throw new UsageError(
      `Unknown config key "${key}". Known keys: ${allConfigKeys().join(', ')}.`,
    );
  }
  const spec = KEY_SPECS[key];
  if (spec.kind === 'cli-managed') {
    throw new UsageError(
      `"${key}" is managed by the CLI (${spec.manageHint}). Use the relevant command to clear it.`,
    );
  }
  return key;
};
