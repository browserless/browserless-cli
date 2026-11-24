import { expect } from 'chai';
import sinon from 'sinon';
import {
  __setKeyringForTests,
  deleteFromKeychain,
  keychainAvailable,
  readFromKeychain,
  writeToKeychain,
} from './keychain.js';

describe('auth/keychain', () => {
  afterEach(() => {
    // Reset the cached keyring instance so subsequent tests get a clean
    // load attempt.
    __setKeyringForTests(undefined);
  });

  describe('when keyring is unavailable (null)', () => {
    beforeEach(() => __setKeyringForTests(null));

    it('keychainAvailable() returns false', async () => {
      expect(await keychainAvailable()).to.be.false;
    });

    it('readFromKeychain() reports the keychain is unavailable', async () => {
      const result = await readFromKeychain('http://x.test');
      expect(result).to.deep.equal({ ok: false, reason: 'unavailable' });
    });

    it('writeToKeychain() reports the keychain is unavailable', async () => {
      const result = await writeToKeychain('http://x.test', 'secret');
      expect(result).to.deep.equal({ ok: false, reason: 'unavailable' });
    });

    it('deleteFromKeychain() reports the keychain is unavailable', async () => {
      const result = await deleteFromKeychain('http://x.test');
      expect(result).to.deep.equal({ ok: false, reason: 'unavailable' });
    });
  });

  describe('when keyring is available', () => {
    // The napi-rs/keyring Entry class takes (service, account) at
    // construction and exposes synchronous getPassword/setPassword/
    // deletePassword. We stub it so we can assert *both* what service +
    // account got constructed AND what each per-instance method was
    // called with.
    let getPassword: sinon.SinonStub;
    let setPassword: sinon.SinonStub;
    let deletePassword: sinon.SinonStub;
    let constructorCalls: Array<[string, string]>;

    beforeEach(() => {
      getPassword = sinon.stub();
      setPassword = sinon.stub();
      deletePassword = sinon.stub().returns(true);
      constructorCalls = [];

      const FakeEntry = class {
        constructor(service: string, account: string) {
          constructorCalls.push([service, account]);
        }
        getPassword() {
          return getPassword();
        }
        setPassword(password: string) {
          return setPassword(password);
        }
        deletePassword() {
          return deletePassword();
        }
      };
      __setKeyringForTests({ Entry: FakeEntry as never });
    });

    it('keychainAvailable() returns true', async () => {
      expect(await keychainAvailable()).to.be.true;
    });

    it('readFromKeychain() returns the password from the keyring', async () => {
      getPassword.returns('stored-token');
      const result = await readFromKeychain('http://x.test');
      expect(result).to.deep.equal({ ok: true, value: 'stored-token' });
      // Service name is the package name; account is the server URL.
      expect(constructorCalls).to.deep.equal([
        ['@browserless.io/cli', 'http://x.test'],
      ]);
      expect(getPassword.calledOnce).to.be.true;
    });

    it('readFromKeychain() returns value:null when no entry exists', async () => {
      getPassword.returns(null);
      const result = await readFromKeychain('http://x.test');
      expect(result).to.deep.equal({ ok: true, value: null });
    });

    it('readFromKeychain() surfaces op-failed when the keyring throws', async () => {
      getPassword.throws(new Error('boom'));
      const result = await readFromKeychain('http://x.test');
      expect(result).to.deep.equal({
        ok: false,
        reason: 'op-failed',
        error: 'boom',
      });
    });

    it('writeToKeychain() reports success', async () => {
      const result = await writeToKeychain('http://x.test', 'tok');
      expect(result).to.deep.equal({ ok: true });
      expect(constructorCalls).to.deep.equal([
        ['@browserless.io/cli', 'http://x.test'],
      ]);
      expect(setPassword.firstCall.args).to.deep.equal(['tok']);
    });

    it('writeToKeychain() surfaces op-failed when the keyring throws', async () => {
      setPassword.throws(new Error('access denied'));
      const result = await writeToKeychain('http://x.test', 'tok');
      expect(result).to.deep.equal({
        ok: false,
        reason: 'op-failed',
        error: 'access denied',
      });
    });

    it('deleteFromKeychain() reports existed=true when the keyring removed an entry', async () => {
      deletePassword.returns(true);
      const result = await deleteFromKeychain('http://x.test');
      expect(result).to.deep.equal({ ok: true, existed: true });
    });

    it('deleteFromKeychain() reports existed=false when no entry to delete', async () => {
      deletePassword.returns(false);
      const result = await deleteFromKeychain('http://x.test');
      expect(result).to.deep.equal({ ok: true, existed: false });
    });

    it('deleteFromKeychain() surfaces op-failed when the keyring throws', async () => {
      deletePassword.throws(new Error('access denied'));
      const result = await deleteFromKeychain('http://x.test');
      expect(result).to.deep.equal({
        ok: false,
        reason: 'op-failed',
        error: 'access denied',
      });
    });
  });
});
