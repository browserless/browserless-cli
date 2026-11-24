import { originMatchesAny } from '../capture/exclusion.js';
import { ProfileAuthState, ProfileOriginStorage } from '../capture/types.js';

// `originMatchesAny` returns true for unparseable origins so they default
// to "drop me" in exclusion / --only-domain semantics. For the keep-pattern
// path that's the wrong default — an unparseable origin would be marked
// protected and never trimmed, leaving the artifact stuck above cap. Gate
// on parseability before checking the keep-pattern list.
const isParseableOrigin = (origin: string): boolean => {
  try {
    new URL(origin);
    return true;
  } catch {
    return false;
  }
};

/**
 * Mirrors the server's `MAX_ARTIFACT_BYTES` constant. The profile route
 * rejects anything larger with HTTP 400 *after* the request-body parser
 * has already let it through. There's also an outer body-parser limit
 * (10 MB in the OSS server today) — we target the inner cap because it's
 * tighter and a successful response requires being under both.
 */
export const SERVER_ARTIFACT_CAP_BYTES = 2 * 1024 * 1024;

/** Per-origin contribution to the serialized state, in bytes. */
export interface OriginSize {
  origin: string;
  bytes: number;
}

/**
 * Measure each origin's contribution to the serialized JSON state.
 * Returned sorted descending (heaviest first) so callers can render a
 * "top-N heaviest" table or pick drop candidates from the front.
 *
 * Note that cookies are NOT in this list — they're a single top-level
 * array, not per-origin, so they can't be dropped origin-by-origin. The
 * sum of origin sizes is always less than the total artifact size by
 * roughly `JSON.stringify(state.cookies).length + envelope overhead`.
 */
export const measureOriginSizes = (
  state: ProfileAuthState,
): OriginSize[] =>
  state.origins
    .map((o) => ({
      origin: o.origin,
      bytes: Buffer.byteLength(JSON.stringify(o), 'utf-8'),
    }))
    .sort((a, b) => b.bytes - a.bytes);

/** Result of a `trimStateToFit` pass. */
export interface TrimResult {
  state: ProfileAuthState;
  serialized: string;
  /** Origins removed by the trim pass, in the order they were dropped. */
  dropped: string[];
  /**
   * Origins that were heavy enough to qualify for dropping but were
   * protected by the `keepPatterns` list. Populated only when the trim
   * stopped short of fitting — empty if the trim succeeded normally.
   */
  protectedFromDrop: string[];
  /** Final byte size after trim. Useful for the post-trim log line. */
  finalBytes: number;
}

/**
 * Drop the heaviest origins (largest serialized contribution first) until
 * the serialized state fits under `budgetBytes`. Cookies are kept as-is.
 *
 * If the state already fits, returns it unchanged with `dropped: []`. If
 * the state can't fit even after dropping every droppable origin (either
 * the cookies + envelope alone exceed the budget, or every remaining
 * origin is in `keepPatterns`), returns the partially-trimmed state with
 * every dropped origin in `dropped` and any heavy-but-protected origins
 * in `protectedFromDrop`. The caller decides whether to bail or continue.
 *
 * `keepPatterns` uses the same suffix-matching semantics as
 * `--exclude-domain` (via `originMatchesAny`): `example.com` protects
 * `example.com`, `www.example.com`, and any subdomain. Empty / omitted
 * means "everything is droppable."
 *
 * Complexity is O(N²) in origin count because we re-serialize after each
 * drop to check the running size. For the typical profile (≤50 origins
 * post-cap) that's tens of milliseconds — the alternative (estimating
 * remaining bytes by subtracting per-origin sizes) is brittle around the
 * JSON delimiters (`,`, `[`, `]`) and easy to get wrong.
 */
export const trimStateToFit = (
  state: ProfileAuthState,
  budgetBytes: number,
  keepPatterns: string[] = [],
): TrimResult => {
  let serialized = JSON.stringify(state);
  let bytes = Buffer.byteLength(serialized, 'utf-8');
  if (bytes <= budgetBytes) {
    return {
      state,
      serialized,
      dropped: [],
      protectedFromDrop: [],
      finalBytes: bytes,
    };
  }

  const dropped: string[] = [];
  const protectedFromDrop: string[] = [];
  // Work on a mutable copy of the origins array; preserve original order
  // among survivors so the artifact's origin list is stable.
  let survivors: ProfileOriginStorage[] = [...state.origins];
  const sizes = measureOriginSizes(state);

  for (const { origin } of sizes) {
    if (bytes <= budgetBytes) break;
    if (
      keepPatterns.length > 0 &&
      isParseableOrigin(origin) &&
      originMatchesAny(origin, keepPatterns)
    ) {
      // Heavy enough to have been considered, but the user said keep it.
      // Record so callers can surface a helpful message when the trim
      // can't reach the budget without dropping these.
      protectedFromDrop.push(origin);
      continue;
    }
    survivors = survivors.filter((o) => o.origin !== origin);
    dropped.push(origin);
    serialized = JSON.stringify({ ...state, origins: survivors });
    bytes = Buffer.byteLength(serialized, 'utf-8');
  }

  return {
    state: { ...state, origins: survivors },
    serialized,
    dropped,
    protectedFromDrop,
    finalBytes: bytes,
  };
};

/** Pretty-print a byte count using the largest unit that yields a number ≥ 1. */
export const formatBytes = (n: number): string => {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
};
