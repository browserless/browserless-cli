/**
 * Snapshot a set of environment variables, clear them, and return a
 * `restore()` callback that puts them back. Used in `beforeEach` /
 * `afterEach` pairs across the auth + disclaimer specs which need a
 * predictable starting env state (no parent-process BROWSERLESS_TOKEN
 * leaking in, no leftover CI flag from another test).
 *
 *     let restoreEnv: () => void;
 *     beforeEach(() => { restoreEnv = captureAndClear(['BROWSERLESS_TOKEN']); });
 *     afterEach(() => restoreEnv());
 *
 * Each key's pre-test value is captured exactly once and restored
 * verbatim — including the "was never set" case, which restores by
 * deleting rather than setting `'undefined'`.
 */
export const captureAndClear = (keys: string[]): (() => void) => {
  const saved = new Map<string, string | undefined>();
  for (const k of keys) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
};
