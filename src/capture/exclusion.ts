import { ProfileAuthState, ProfileCookie } from './types.js';

/**
 * Normalize a user-supplied exclusion pattern to its bare hostname:
 *   "*.example.com"  → "example.com"
 *   ".example.com"   → "example.com"
 *   "EXAMPLE.com"    → "example.com"
 *   "https://example.com/foo" → "example.com"
 *
 * Empty / whitespace-only strings produce `null` and are filtered out by
 * the caller.
 */
export const normalizeExclusion = (raw: string): string | null => {
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('*.')) value = value.slice(2);
  if (value.startsWith('.')) value = value.slice(1);
  // Strip scheme + path so users can paste a URL, AND coerce non-ASCII
  // hostnames to punycode (the form Chrome stores in `cookie.domain`).
  // We synthesise a URL on bare hostnames so both code paths go through
  // the same WHATWG-URL hostname parser.
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.hostname) value = url.hostname;
  } catch {
    // not a parseable URL or hostname — keep what we have
  }
  return value || null;
};

/**
 * Suffix-match: does `host` belong to (or equal) `pattern`?
 * `pattern` is already normalized. Both `host` and `pattern` are
 * lowercase ASCII at this point.
 */
const hostMatches = (host: string, pattern: string): boolean => {
  if (host === pattern) return true;
  if (host.endsWith(`.${pattern}`)) return true;
  return false;
};

/**
 * Test whether an origin URL's hostname matches any pattern in the list.
 * Used by `capture/cdp.ts` for pre-navigation skip (so we don't waste a
 * tab on origins we'd drop afterwards anyway). Returns `true` for
 * unparseable origins so they're dropped defensively.
 */
export const originMatchesAny = (
  origin: string,
  patterns: string[],
): boolean => {
  if (patterns.length === 0) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return true;
  }
  for (const raw of patterns) {
    const p = normalizeExclusion(raw);
    if (p && hostMatches(host, p)) return true;
  }
  return false;
};

/** Strip a single leading `.` from a cookie domain before comparing. */
const cookieHost = (cookie: ProfileCookie): string => {
  const d = cookie.domain.toLowerCase();
  return d.startsWith('.') ? d.slice(1) : d;
};

/**
 * Allowlist semantics for a single origin. Unparseable origins return
 * `false` here — the inverse of `originMatchesAny`'s exclusion-friendly
 * "drop-by-default" treatment.
 */
export const originAllowedBy = (
  origin: string,
  patterns: string[],
): boolean => {
  if (patterns.length === 0) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const raw of patterns) {
    const p = normalizeExclusion(raw);
    if (p && hostMatches(host, p)) return true;
  }
  return false;
};

/**
 * Apply the user's exclusion list to a captured ProfileAuthState. Returns
 * a new state plus counts of what was dropped, for the CLI's diagnostic
 * line. Excluded entries never leave the user's machine — the filter runs
 * client-side before serializing the upload payload, so the server never
 * sees the excluded cookies or origins.
 */
export interface ExclusionResult {
  state: ProfileAuthState;
  cookiesDropped: number;
  originsDropped: number;
}

export const applyExclusions = (
  input: ProfileAuthState,
  patterns: string[],
): ExclusionResult => {
  const normalized = patterns
    .map(normalizeExclusion)
    .filter((p): p is string => p !== null);

  if (normalized.length === 0) {
    return { state: input, cookiesDropped: 0, originsDropped: 0 };
  }

  const isExcluded = (host: string): boolean =>
    normalized.some((p) => hostMatches(host, p));

  const filteredCookies = input.cookies.filter(
    (c) => !isExcluded(cookieHost(c)),
  );

  const filteredOrigins = input.origins.filter((o) => {
    try {
      return !isExcluded(new URL(o.origin).hostname.toLowerCase());
    } catch {
      // unparseable origin → drop defensively rather than risk leaking it
      return false;
    }
  });

  return {
    state: { cookies: filteredCookies, origins: filteredOrigins },
    cookiesDropped: input.cookies.length - filteredCookies.length,
    originsDropped: input.origins.length - filteredOrigins.length,
  };
};

/** Merge config-stored excludes with --exclude-domain flag values. */
export const mergeExclusionPatterns = (
  configList: string[] | undefined,
  flagList: string[] | undefined,
  noDefault: boolean,
): string[] => {
  const flag = flagList ?? [];
  if (noDefault) return flag;
  return [...(configList ?? []), ...flag];
};

/**
 * Allowlist counterpart to `applyExclusions`. Drops every cookie and
 * origin whose host does NOT match any pattern in `patterns`. Pattern
 * matching reuses `hostMatches` so `--only-domain google.com` keeps
 * `mail.google.com` cookies / origins (suffix-match, same as
 * `--exclude-domain`).
 *
 * Empty / omitted `patterns` is a no-op (returns the input unchanged) —
 * that way callers don't need to special-case the "user didn't ask for
 * an allowlist" path.
 */
export interface OnlyFilterResult {
  state: ProfileAuthState;
  cookiesDropped: number;
  originsDropped: number;
}

export const applyOnlyFilter = (
  input: ProfileAuthState,
  patterns: string[],
): OnlyFilterResult => {
  const normalized = patterns
    .map(normalizeExclusion)
    .filter((p): p is string => p !== null);

  if (normalized.length === 0) {
    return { state: input, cookiesDropped: 0, originsDropped: 0 };
  }

  const isKept = (host: string): boolean =>
    normalized.some((p) => hostMatches(host, p));

  const filteredCookies = input.cookies.filter((c) => isKept(cookieHost(c)));

  const filteredOrigins = input.origins.filter((o) => {
    try {
      return isKept(new URL(o.origin).hostname.toLowerCase());
    } catch {
      // unparseable origin → drop (allowlist is "must match" — unparseable
      // can't match, so it gets dropped)
      return false;
    }
  });

  return {
    state: { cookies: filteredCookies, origins: filteredOrigins },
    cookiesDropped: input.cookies.length - filteredCookies.length,
    originsDropped: input.origins.length - filteredOrigins.length,
  };
};
