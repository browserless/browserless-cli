/**
 * `@napi-rs/keyring` wrapper. The dep is declared as `optionalDependencies`
 * in `package.json` so `npm install` doesn't fail when the prebuilt
 * native bindings aren't available for the host platform. The runtime
 * import is dynamic and tolerates a missing module — when the keyring
 * isn't available, `auth/store` falls back to mode-0600 file storage.
 *
 * Write and delete return a discriminated result so callers can tell
 * "keychain not present, fall back is fine" apart from "keychain is
 * here but the operation failed" — the latter must surface to the user
 * because silently downgrading to plaintext storage on a transient
 * unlock prompt is a security regression.
 *
 * Service name `@browserless.io/cli` is the npm package name; account
 * is the server URL so one host can hold credentials for multiple
 * Browserless deployments side by side.
 */
import { errMessage } from '../utils/errors.js';

const SERVICE_NAME = '@browserless.io/cli';

/**
 * Minimal `Entry` surface we depend on from `@napi-rs/keyring`. Kept as
 * a local interface so the test seam can inject an in-memory fake
 * without taking a hard dep on the real module.
 */
interface EntryLike {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

interface KeyringLike {
  Entry: new (service: string, account: string) => EntryLike;
}

export type KeychainWriteResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' }
  | { ok: false; reason: 'op-failed'; error: string };

export type KeychainDeleteResult =
  | { ok: true; existed: boolean }
  | { ok: false; reason: 'unavailable' }
  | { ok: false; reason: 'op-failed'; error: string };

/**
 * Read result. `ok: true, value: null` means the keychain is reachable
 * but no entry exists — fall through to the file/env path silently.
 * `op-failed` means the keychain is reachable but threw on read — surface
 * to the user; silently falling back here would let a locked keychain
 * present as "no entry exists" and the user would lose access to a
 * stored token without ever being told why.
 */
export type KeychainReadResult =
  | { ok: true; value: string | null }
  | { ok: false; reason: 'unavailable' }
  | { ok: false; reason: 'op-failed'; error: string };

let cached: KeyringLike | null | undefined;

const loadKeyring = async (): Promise<KeyringLike | null> => {
  if (cached !== undefined) return cached;
  // Escape hatch for environments where keyring loads but can't actually
  // be used interactively — e.g. macOS CI runners with no GUI to grant
  // Keychain permission, where `setPassword` blocks indefinitely. Setting
  // BROWSERLESS_DISABLE_KEYCHAIN=1 forces the file-fallback path. Also
  // useful for users who explicitly want plaintext config (audit reqs).
  if (process.env.BROWSERLESS_DISABLE_KEYCHAIN === '1') {
    cached = null;
    return null;
  }
  try {
    const mod = (await import('@napi-rs/keyring')) as unknown as
      | KeyringLike
      | { default: KeyringLike };
    cached = 'default' in mod ? mod.default : (mod as KeyringLike);
  } catch {
    cached = null;
  }
  return cached;
};

/**
 * Test-only seam for swapping the keyring instance without going through
 * the dynamic import. Pass `null` to force the file-fallback path; pass a
 * mock to assert keychain interactions; pass `undefined` to reset the
 * cache so the next call re-imports the real module.
 *
 * Not part of the public API — only `src/test-helpers/mock-keychain.ts`
 * should use this.
 */
export const __setKeyringForTests = (
  instance: KeyringLike | null | undefined,
): void => {
  cached = instance;
};

export const keychainAvailable = async (): Promise<boolean> => {
  const k = await loadKeyring();
  return k !== null;
};

export const readFromKeychain = async (
  account: string,
): Promise<KeychainReadResult> => {
  const k = await loadKeyring();
  if (!k) return { ok: false, reason: 'unavailable' };
  try {
    const entry = new k.Entry(SERVICE_NAME, account);
    return { ok: true, value: entry.getPassword() };
  } catch (err) {
    return { ok: false, reason: 'op-failed', error: errMessage(err) };
  }
};

export const writeToKeychain = async (
  account: string,
  secret: string,
): Promise<KeychainWriteResult> => {
  const k = await loadKeyring();
  if (!k) return { ok: false, reason: 'unavailable' };
  try {
    const entry = new k.Entry(SERVICE_NAME, account);
    entry.setPassword(secret);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'op-failed', error: errMessage(err) };
  }
};

export const deleteFromKeychain = async (
  account: string,
): Promise<KeychainDeleteResult> => {
  const k = await loadKeyring();
  if (!k) return { ok: false, reason: 'unavailable' };
  try {
    const entry = new k.Entry(SERVICE_NAME, account);
    const existed = entry.deletePassword();
    return { ok: true, existed };
  } catch (err) {
    return { ok: false, reason: 'op-failed', error: errMessage(err) };
  }
};
