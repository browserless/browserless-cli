import type { Command } from 'commander';
import { resolveServer, resolveToken } from '../auth/store.js';
import { ClientOptions } from '../api/client.js';
import { UsageError } from '../errors.js';
import { KNOWN_REGIONS } from '../regions.js';

/**
 * Build an authenticated client from CLI flags + persisted config. Used by
 * every verb that talks to the server. Centralized so the `--server` /
 * `--region` flag overrides and the env-var hierarchy are applied
 * consistently everywhere.
 */
export const buildClient = async (opts: {
  token?: string;
  server?: string;
  region?: string;
}): Promise<ClientOptions & { source: string }> => {
  const server = await resolveServer({
    server: opts.server,
    region: opts.region,
  });
  const { token, source } = await resolveToken({
    flag: opts.token,
    server,
  });
  return { server, token, source };
};

export const collectRepeated = (
  value: string,
  previous: string[] | undefined,
): string[] => {
  const list = previous ?? [];
  return [...list, value];
};

/**
 * `--server <url>` + `--region <code>` flags. Registered by every verb
 * that needs to talk to the server, including the auth verbs that don't
 * use the full client (login / logout / status read server independently
 * of token resolution). Stays narrower than `addClientFlags` so those
 * verbs don't pick up `--token` / `--json` they don't use.
 */
export const addServerOverrideFlags = (cmd: Command): Command =>
  cmd
    .option('--server <url>', 'Browserless server URL')
    .option(
      '--region <code>',
      `Browserless region (${KNOWN_REGIONS.join(' | ')}) — shorthand for --server`,
    );

/**
 * Full client-flag set: composes `addServerOverrideFlags` (--server +
 * --region) and adds --token + --json on top. Used by every verb that
 * hits the cloud API. `--region` is sugar for the matching production
 * server URL; pass `--server <url>` for self-hosted or staging endpoints.
 */
export const addClientFlags = (cmd: Command): Command =>
  addServerOverrideFlags(
    cmd.option(
      '--token <token>',
      'API token (overrides env / keychain / file). Visible to other local users in the process list — prefer BROWSERLESS_TOKEN or `auth login`',
    ),
  ).option('--json', 'Emit the server response as JSON');

/**
 * Pretty-print a value to stdout as JSON with a trailing newline. Used by
 * every command that supports `--json`.
 */
export const printJson = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
};

/**
 * Parse a CLI flag value as a non-negative integer.
 *
 * `Number()` is too permissive on its own: it accepts hex (`"0x10"` → 16),
 * scientific notation (`"1e3"` → 1000), trailing/leading whitespace, and
 * `""` (→ 0). All of those silently produce a "valid" integer that the
 * user never intended — `--limit 0x10` would quietly fetch 16 profiles.
 * Pre-validate against a strict decimal-digits regex so the only inputs
 * that pass are what the user can read back.
 *
 * Pass `min` if zero is invalid for the flag in question (e.g. --limit
 * passes 1 to require a positive integer).
 */
const DECIMAL_INT_RE = /^\d+$/;

export const parseNonNegativeInt = (
  flagName: string,
  raw: string,
  min: number = 0,
): number => {
  const fail = (): never => {
    throw new UsageError(
      `${flagName} must be a${min > 0 ? ' positive' : ' non-negative'} integer (got "${raw}")`,
      'invalid-integer-flag',
    );
  };
  if (!DECIMAL_INT_RE.test(raw)) fail();
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) fail();
  return n;
};
