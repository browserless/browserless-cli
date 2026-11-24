import { version } from '../version.js';
import { isLoopbackHostname } from '../utils/loopback.js';

/**
 * Default account-API host the CLI posts analytics to. This is the
 * Browserless account API (api.browserless.io), NOT the per-region browser
 * server the rest of the CLI talks to — telemetry is routed here so the
 * server resolves the token to an account and strips it before anything
 * reaches analytics. Override with `BROWSERLESS_API_URL` for dev / staging.
 */
const DEFAULT_API_URL = 'https://api.browserless.io';

export const apiBaseUrl = (): string => {
  const raw = process.env.BROWSERLESS_API_URL?.trim() || DEFAULT_API_URL;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
};

export const isTrustedApiBase = (base: string): boolean => {
  try {
    const { protocol, hostname } = new URL(base);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return (
      isLoopbackHostname(hostname) ||
      (protocol === 'https:' &&
        (hostname === 'browserless.io' || hostname.endsWith('.browserless.io')))
    );
  } catch {
    return false;
  }
};

export interface CliEvent {
  event_type: string;
  time: number;
  event_properties: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 2_000;

// Sent so the server can forward it to analytics as the event `platform`.
// Without it, undici's default `User-Agent: node` makes every CLI event's
// platform read `node` instead of identifying the client.
const USER_AGENT = `@browserless.io/cli/${version}`;

/**
 * POST analytics events to `POST {API_URL}/v2/cli/events`, authenticated with
 * the caller's Browserless token via the `Authorization` header.
 *
 * Strictly best-effort: never throws (resolves to a boolean) and is hard-
 * bounded by `timeoutMs` via an AbortController. This matters because the
 * top-level handler in `cli.ts` lets the event loop drain instead of calling
 * `process.exit()`, so a telemetry request left hanging would stall shutdown.
 * The response body is drained so the socket is released promptly.
 */
export const postCliEvents = async (
  events: CliEvent[],
  opts: { token: string; timeoutMs?: number; baseUrl?: string },
): Promise<boolean> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = opts.baseUrl ?? apiBaseUrl();
  if (!isTrustedApiBase(base)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v2/cli/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify({ events }),
      signal: controller.signal,
      // Same as apiFetch: a redirect would re-send the token (fetch keeps the
      // Authorization header on same-origin hops), so never follow one.
      redirect: 'error',
    });
    await res.text().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};
