/**
 * Coalesce an unknown thrown value (caught from try/catch) into a stable
 * string. Used at boundaries that store / propagate the error verbatim
 * (e.g. our keychain result discriminator, the per-origin capture
 * failure list).
 *
 * `String(err)` works on most things but produces `[object Object]` for
 * plain objects and ignores `.message` on Error instances — both bad
 * UX. Prefer `.message` when we have it, fall back otherwise.
 */
export const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
