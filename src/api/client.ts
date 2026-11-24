import { ApiError } from '../errors.js';
import { terminalSafe } from '../utils/terminal.js';

export interface ClientOptions {
  server: string;
  token: string;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** Optional profile-setup correlation; malformed values are ignored. */
  attemptId?: string;
  /** Pre-serialized JSON body. Pass an object and we'll JSON.stringify it. */
  body?: unknown;
  /** Pre-serialized string body — used by capture/upload to skip a re-stringify. */
  rawBody?: string;
  /** Extra query params merged after the token. */
  query?: Record<string, string | number | undefined>;
  /**
   * Per-request timeout in ms. Default 30 s — large enough for upload of a
   * full 2 MB profile artifact on a slow link, small enough that a hung
   * server doesn't block the CLI indefinitely.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
// Fetch exposes decoded chunks, so compressed responses share this budget.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export const profileAttemptId = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
    ? value.toLowerCase()
    : undefined;

const buildUrl = (
  server: string,
  path: string,
  token: string,
  query: Record<string, string | number | undefined> | undefined,
): URL => {
  // `new URL('/x', 'https://h/prefix/')` resolves to `https://h/x` —
  // the leading slash in the path makes it absolute, discarding any
  // path prefix on the server. Self-hosters behind a reverse proxy
  // (e.g. `https://example.com/browserless/`) need the prefix preserved,
  // so normalize: trailing-slash on the base, strip leading slashes off
  // the path, then resolve. With no prefix this is identical to the
  // previous behaviour.
  const base = server.endsWith('/') ? server : `${server}/`;
  const relative = path.replace(/^\/+/, '');
  const url = new URL(relative, base);
  url.searchParams.set('token', token);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url;
};

const messageFromBody = (
  status: number,
  statusText: string,
  body: string,
): string => {
  if (!body) return `HTTP ${status} ${terminalSafe(statusText)}`;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.message && typeof parsed.message === 'string') {
      return terminalSafe(parsed.message);
    }
  } catch {
    // not JSON — keep as text
  }
  const trimmed = body.trim();
  return trimmed.length > 200
    ? `HTTP ${status} ${terminalSafe(statusText)}: ${terminalSafe(trimmed.slice(0, 200))}…`
    : `HTTP ${status} ${terminalSafe(statusText)}: ${terminalSafe(trimmed)}`;
};

/**
 * Authed fetch wrapper. Maps non-2xx responses to ApiError with the
 * server's error message extracted from the JSON body when available.
 */
export const apiFetch = async <T>(
  client: ClientOptions,
  options: RequestOptions,
): Promise<T> => {
  const url = buildUrl(
    client.server,
    options.path,
    client.token,
    options.query,
  );

  // Only set Content-Type when we're actually sending a body — some servers
  // (including Browserless's body parser) try to JSON.parse the empty body
  // when Content-Type advertises JSON, and respond with 400 before our
  // handler ever runs.
  // Redirects must not replay credentials or profile state to another URL.
  const init: RequestInit = { method: options.method, redirect: 'error' };
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
  }
  if (body !== undefined) {
    init.body = body;
    init.headers = { 'Content-Type': 'application/json' };
  }
  const attemptId = profileAttemptId(options.attemptId);
  if (attemptId) {
    init.headers = { ...init.headers, 'x-browserless-attempt-id': attemptId };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;

  let res: Response | undefined;
  let text = '';
  try {
    res = await fetch(url, init);
    const decoder = new TextDecoder();
    let bytes = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          controller.abort();
          throw new ApiError(
            `Response exceeds the ${MAX_RESPONSE_BYTES}-byte decoded body limit`,
            0,
            undefined,
            'response-too-large',
          );
        }
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
    }
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    if (err?.name === 'AbortError') {
      throw new ApiError(
        `Request to ${client.server}${options.path} timed out after ${timeoutMs}ms`,
        0,
        undefined,
        'request-timeout',
      );
    }
    throw new ApiError(
      res
        ? `Failed to read response from ${client.server}${options.path}: ${err?.message ?? err}`
        : `Failed to reach ${client.server}: ${err?.message ?? err}`,
      0,
      undefined,
      res ? 'response-read-failed' : 'network-unreachable',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ApiError(
      messageFromBody(res.status, res.statusText, text),
      res.status,
      text,
    );
  }
  if (res.status === 204 || !text) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(
      `Server returned non-JSON response: ${terminalSafe(text)}`,
      res.status,
      text,
      'invalid-response',
    );
  }
};
