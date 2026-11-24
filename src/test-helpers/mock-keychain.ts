import sinon from 'sinon';
import { __setKeyringForTests } from '../auth/keychain.js';

/**
 * Flat per-method stubs exposed to tests, mirroring the
 * (service, account[, password]) signature of the legacy keytar API.
 * The wrapper internally adapts these to `@napi-rs/keyring`'s
 * Entry-instance shape: each `new Entry(service, account)` constructed
 * by production code delegates to these shared stubs, so test assertions
 * like `kc.setPassword.firstCall.args[1]` continue to see the
 * (service, account, password) tuple regardless of which underlying
 * native binding the production code uses.
 */
export interface FakeKeychain {
  getPassword: sinon.SinonStub;
  setPassword: sinon.SinonStub;
  deletePassword: sinon.SinonStub;
}

const buildEntryConstructor = (fake: FakeKeychain) =>
  class FakeEntry {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}
    getPassword(): string | null {
      return fake.getPassword(this.service, this.account);
    }
    setPassword(password: string): void {
      fake.setPassword(this.service, this.account, password);
    }
    deletePassword(): boolean {
      return fake.deletePassword(this.service, this.account);
    }
  };

/**
 * Install an in-memory keychain backend in place of the real
 * `@napi-rs/keyring` import for the duration of a test. Returns the
 * stub object so assertions can verify what the CLI tried to read/write.
 *
 * Pair with `uninstallFakeKeychain()` in `afterEach`.
 */
export const installFakeKeychain = (
  initial: Record<string, string> = {},
): FakeKeychain => {
  const store = new Map<string, string>(Object.entries(initial));

  const fake: FakeKeychain = {
    getPassword: sinon.stub().callsFake((_service: string, account: string) => {
      return store.has(account) ? store.get(account)! : null;
    }),
    setPassword: sinon.stub().callsFake(
      (_service: string, account: string, password: string) => {
        store.set(account, password);
      },
    ),
    deletePassword: sinon.stub().callsFake((_service: string, account: string) => {
      const had = store.has(account);
      store.delete(account);
      return had;
    }),
  };

  __setKeyringForTests({ Entry: buildEntryConstructor(fake) as never });
  return fake;
};

/** Force the keychain to be unavailable — callers fall back to file storage. */
export const installNoKeychain = (): void => {
  __setKeyringForTests(null);
};

/**
 * Install a keychain whose operations throw. Simulates the "present but
 * locked / access denied" case (e.g. macOS Keychain access denied dialog,
 * Linux libsecret D-Bus error) — callers must surface this rather than
 * silently degrading to plaintext storage.
 *
 * Real keychain errors carry platform-specific `.code` properties (macOS
 * `errSecAuthFailed`, Linux D-Bus `org.freedesktop.DBus.Error.NoReply`).
 * Pass `code` to simulate that — tests that need to assert behavior keyed
 * on `.code` (e.g. retry on `NoReply`) can opt in without other tests
 * caring. Default omits `.code` since most consumers only read `.message`.
 */
export const installThrowingKeychain = (
  message = 'access denied',
  code?: string,
): void => {
  const throwIt = (): never => {
    const err = new Error(message) as Error & { code?: string };
    if (code !== undefined) err.code = code;
    throw err;
  };
  const Entry = class {
    constructor(_service: string, _account: string) {}
    getPassword(): string | null {
      return throwIt();
    }
    setPassword(_password: string): void {
      throwIt();
    }
    deletePassword(): boolean {
      return throwIt();
    }
  };
  __setKeyringForTests({ Entry: Entry as never });
};

/** Restore the cached keyring instance to "load on next call". */
export const uninstallFakeKeychain = (): void => {
  __setKeyringForTests(undefined);
};
