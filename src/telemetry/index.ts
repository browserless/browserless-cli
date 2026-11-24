import { performance } from 'node:perf_hooks';
import type { Command } from 'commander';
import { readConfig } from '../config/store.js';
import { errorTelemetryOf, type ErrorCategory } from '../errors.js';
import {
  REGION_URLS,
  KNOWN_REGIONS,
  RegionCode,
  isKnownRegion,
} from '../regions.js';
import { version } from '../version.js';
import { commandPath, usedFlagNames } from './command-meta.js';
import { getRecordedToken } from './token-cache.js';
import { getOrCreateDeviceId } from './device-id.js';
import {
  apiBaseUrl,
  CliEvent,
  isTrustedApiBase,
  postCliEvents,
} from './api.js';

const EVENT_NAME = 'CLI Command Run';

const isTruthyEnv = (value: string | undefined): boolean =>
  value !== undefined &&
  value !== '' &&
  value !== '0' &&
  value.toLowerCase() !== 'false';

// Read lazily (not frozen at module load) so it's overridable per-process and
// testable. A non-positive / non-numeric value is ignored — it can't make the
// flush abort instantly and silently disable sending for the run.
export const flushTimeoutMs = (): number => {
  const parsed = Number(process.env.BROWSERLESS_TELEMETRY_TIMEOUT_MS);
  return parsed > 0 ? parsed : 2_000;
};

// Opt-in stderr diagnostics (BROWSERLESS_TELEMETRY_DEBUG=1) so dropped and sent
// events are visible — the pipeline is otherwise silent by design.
const debug = (message: string): void => {
  if (isTruthyEnv(process.env.BROWSERLESS_TELEMETRY_DEBUG)) {
    process.stderr.write(`[telemetry] ${message}\n`);
  }
};

interface PendingCommand {
  /** Full noun-verb path, e.g. "profile upload" / "agent". */
  command: string;
  /** Names of flags the user explicitly passed (never their values). */
  flags: string[];
  /** Monotonic start time (performance.now()) — immune to wall-clock steps. */
  startedAt: number;
}

let pending: PendingCommand | undefined;
let setupEvents: CliEvent[] = [];

/** Bounded per-command queue, flushed under the existing consent/token policy. */
export const recordProfileSetupEvent = (event: CliEvent): void => {
  if (pending && setupEvents.length < 6) setupEvents.push(event);
};

export type CompletionResult =
  | { status: 'ok'; exitCode: number }
  | {
      status: 'error';
      exitCode: number;
      errorName?: string;
      errorCode?: string;
      errorCategory?: ErrorCategory;
      httpStatus?: number;
    };

export const errorResult = (
  err: unknown,
  exitCode: number,
): CompletionResult => ({
  status: 'error',
  exitCode,
  ...errorTelemetryOf(err),
});

/** Closed shape of the `CLI Command Run` event_properties — adding a key is a
 *  deliberate, reviewable edit. A type alias (not an interface) so it stays
 *  assignable to the transport's `Record<string, unknown>`. `server_region` is
 *  a `RegionCode`: non-cloud servers are dropped before an event is built. */
type CliCommandRunProperties = {
  command: string;
  flags: string[];
  status: 'ok' | 'error';
  exit_code: number;
  error_name?: string;
  error_code?: string;
  error_category?: ErrorCategory;
  http_status?: number;
  duration_ms: number;
  cli_version: string;
  os: string;
  arch: string;
  node_major: number;
  is_ci: boolean;
  server_region: RegionCode;
  cli_device_id: string;
};

/**
 * Whether usage analytics are enabled for this run. Opt-out precedence:
 *   1. `BROWSERLESS_TELEMETRY_DISABLED` (any truthy value)
 *   2. `DO_NOT_TRACK` (the cross-tool standard)
 *   3. the `telemetry` config key
 *
 * Fail-closed: enabled only for an explicit boolean `true` or an absent key.
 * config.json is a user-owned plaintext file that isn't type-validated, so a
 * hand-edited junk value (e.g. the string `"false"`) disables — same direction
 * as the read-error branch. Never track when consent is ambiguous.
 */
export const isEnabled = async (): Promise<boolean> => {
  if (isTruthyEnv(process.env.BROWSERLESS_TELEMETRY_DISABLED)) return false;
  if (isTruthyEnv(process.env.DO_NOT_TRACK)) return false;
  try {
    const config = await readConfig();
    return config.telemetry === undefined || config.telemetry === true;
  } catch {
    return false;
  }
};

// Takes the commander Command (not pre-extracted strings) so only sanitized,
// names-only flag data can ever enter telemetry — raw argv / flag values can't
// cross this seam.
export const begin = (cmd: Command): void => {
  setupEvents = [];
  pending = {
    command: commandPath(cmd),
    flags: usedFlagNames(cmd),
    startedAt: performance.now(),
  };
};

/**
 * Bucket a server URL to its production region code, or `custom` for anything
 * else. Compares URL origins, so a trailing slash or differing case still
 * matches a known region.
 */
export const bucketServerUrl = (server: string): RegionCode | 'custom' => {
  let origin: string;
  try {
    origin = new URL(server).origin;
  } catch {
    return 'custom';
  }
  const match = KNOWN_REGIONS.find((region) => {
    try {
      return new URL(REGION_URLS[region]).origin === origin;
    } catch {
      return false;
    }
  });
  return match ?? 'custom';
};

const nodeMajor = (): number =>
  Number(process.versions.node.split('.')[0]) || 0;

const buildEvent = (
  cmd: PendingCommand,
  result: CompletionResult,
  region: RegionCode,
  deviceId: string,
): CliEvent => {
  const properties: CliCommandRunProperties = {
    command: cmd.command,
    flags: cmd.flags,
    status: result.status,
    exit_code: result.exitCode,
    error_name: result.status === 'error' ? result.errorName : undefined,
    error_code: result.status === 'error' ? result.errorCode : undefined,
    error_category:
      result.status === 'error' ? result.errorCategory : undefined,
    http_status: result.status === 'error' ? result.httpStatus : undefined,
    duration_ms: Math.round(performance.now() - cmd.startedAt),
    cli_version: version,
    os: process.platform,
    arch: process.arch,
    node_major: nodeMajor(),
    is_ci: isTruthyEnv(process.env.CI),
    server_region: region,
    cli_device_id: deviceId,
  };
  return {
    event_type: EVENT_NAME,
    time: Date.now(),
    event_properties: properties,
  };
};

/**
 * Flush one "CLI Command Run" event and any bounded setup transitions.
 * Strictly best-effort: never throws and never fails
 * or changes the command. The command's own work is already done by the time
 * this runs; because `cli.ts` drains the event loop instead of calling
 * `process.exit()`, the process waits for this POST to settle (bounded by the
 * flush timeout) before exiting.
 *
 * A no-op unless a command was started, telemetry is enabled, the command
 * authenticated this run, AND that token was resolved against a known
 * production region. A self-hosted server's token is a credential to the
 * user's own deployment and is never sent to the cloud API (it couldn't be
 * attributed there anyway); the region is taken from the server the token was
 * resolved for, not from a flag, so the credential can't be mismatched.
 */
export const complete = async (result: CompletionResult): Promise<void> => {
  const cmd = pending;
  pending = undefined;
  const transitions = setupEvents;
  setupEvents = [];
  if (!cmd) return;
  try {
    if (!(await isEnabled())) {
      debug('skipped: telemetry disabled');
      return;
    }
    const recorded = getRecordedToken();
    if (!recorded) {
      debug('skipped: no token resolved this run');
      return;
    }
    const region = bucketServerUrl(recorded.server);
    if (!isKnownRegion(region)) {
      debug('skipped: non-cloud server');
      return;
    }
    if (!isTrustedApiBase(apiBaseUrl())) {
      debug('skipped: BROWSERLESS_API_URL is not a Browserless host');
      return;
    }
    const deviceId = await getOrCreateDeviceId();
    const event = buildEvent(cmd, result, region, deviceId);
    const ok = await postCliEvents([event, ...transitions], {
      token: recorded.token,
      timeoutMs: flushTimeoutMs(),
    });
    debug(ok ? `sent (${region})` : `send failed (${region})`);
  } catch {
    // Telemetry is best-effort and must never change the command's behaviour
    // or exit code — swallow everything (and surface it only under debug).
    debug('skipped: error while flushing');
  }
};

export const _resetForTests = (): void => {
  pending = undefined;
  setupEvents = [];
};
