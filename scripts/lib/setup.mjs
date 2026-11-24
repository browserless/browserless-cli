/**
 * Per-script temp-dir + env-var setup shared by the cli-*-smoke.mjs
 * scripts.
 *
 * Each script wants a fresh `BROWSERLESS_CONFIG_DIR` pointing at a
 * scratch tmpdir, the disclaimer pre-accepted (`BROWSERLESS_ACCEPT_TERMS=1`),
 * and — for most scripts — the keychain disabled so CI runners without
 * an interactive Keychain session don't block on permission prompts.
 *
 * The cli-keychain-smoke script is the deliberate exception: it leaves
 * the keychain enabled to exercise the real OS credential store. Pass
 * `{ disableKeychain: false }` there.
 *
 * Returns `{ tempRoot, configDir, cleanup }`. Call `cleanup()` at the
 * end of the script to remove the tmpdir.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {object} [opts]
 * @param {string} [opts.prefix]            mkdtemp prefix (default: 'browserless-cli-')
 * @param {boolean} [opts.disableKeychain]  set BROWSERLESS_DISABLE_KEYCHAIN=1 (default: true)
 * @param {boolean} [opts.acceptTerms]      set BROWSERLESS_ACCEPT_TERMS=1   (default: true)
 * @param {number}  [opts.cdpWaitMs]        set BROWSERLESS_CDP_WAIT_MS (default: unset)
 */
export const setupSmokeEnv = (opts = {}) => {
  const tempRoot = mkdtempSync(
    path.join(os.tmpdir(), opts.prefix ?? 'browserless-cli-'),
  );
  const configDir = path.join(tempRoot, 'cli-config');

  process.env.BROWSERLESS_CONFIG_DIR = configDir;
  // Always clear any stray BROWSERLESS_TOKEN from the parent environment
  // so token-resolution tests start from a known empty state.
  delete process.env.BROWSERLESS_TOKEN;

  if (opts.acceptTerms ?? true) {
    process.env.BROWSERLESS_ACCEPT_TERMS = '1';
  }
  if (opts.disableKeychain ?? true) {
    process.env.BROWSERLESS_DISABLE_KEYCHAIN = '1';
  } else {
    // Caller explicitly wants the keychain enabled — make sure no prior
    // run of a different smoke script left DISABLE=1 around.
    delete process.env.BROWSERLESS_DISABLE_KEYCHAIN;
  }
  if (opts.cdpWaitMs !== undefined) {
    process.env.BROWSERLESS_CDP_WAIT_MS = String(opts.cdpWaitMs);
  }

  const cleanup = () => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  return { tempRoot, configDir, cleanup };
};
