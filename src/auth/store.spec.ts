import { expect } from 'chai';
import { setupTempHome, TempHome } from '../test-helpers/temp-home.js';
import {
  installFakeKeychain,
  installNoKeychain,
  installThrowingKeychain,
  uninstallFakeKeychain,
} from '../test-helpers/mock-keychain.js';
import { captureAndClear } from '../test-helpers/env.js';
import {
  clearToken,
  persistToken,
  resolveServer,
  resolveToken,
} from './store.js';
import { writeConfig } from '../config/store.js';
import { PreconditionError, UsageError } from '../errors.js';
import { DEFAULT_SERVER } from '../config/schema.js';
import { expectRejects } from '../test-helpers/assertions.js';
import {
  getRecordedToken,
  _resetRecordedTokenForTests,
} from '../telemetry/token-cache.js';

describe('auth/store', () => {
  let home: TempHome;
  let restoreEnv: () => void;

  beforeEach(async () => {
    home = await setupTempHome();
    restoreEnv = captureAndClear([
      'BROWSERLESS_TOKEN',
      'BROWSERLESS_ALLOW_INSECURE_HTTP',
    ]);
    _resetRecordedTokenForTests();
  });

  afterEach(async () => {
    uninstallFakeKeychain();
    restoreEnv();
    await home.cleanup();
  });

  describe('resolveToken records the token for telemetry', () => {
    it('records a flag token bound to the server', async () => {
      await resolveToken({ flag: 'flag-tok', server: DEFAULT_SERVER });
      expect(getRecordedToken()).to.deep.equal({
        token: 'flag-tok',
        server: DEFAULT_SERVER,
      });
    });

    it('records an env token bound to the server', async () => {
      process.env.BROWSERLESS_TOKEN = 'env-tok';
      await resolveToken({ server: DEFAULT_SERVER });
      expect(getRecordedToken()).to.deep.equal({
        token: 'env-tok',
        server: DEFAULT_SERVER,
      });
    });

    it('records a token resolved from the config file', async () => {
      installNoKeychain();
      await writeConfig({ api_key: 'file-tok' });
      const resolved = await resolveToken({ server: DEFAULT_SERVER });
      expect(resolved.source).to.equal('file');
      expect(getRecordedToken()).to.deep.equal({
        token: 'file-tok',
        server: DEFAULT_SERVER,
      });
    });

    it('records a token resolved from the keychain', async () => {
      installFakeKeychain({ [DEFAULT_SERVER]: 'keychain-tok' });
      const resolved = await resolveToken({ server: DEFAULT_SERVER });
      expect(resolved.source).to.equal('keychain');
      expect(getRecordedToken()).to.deep.equal({
        token: 'keychain-tok',
        server: DEFAULT_SERVER,
      });
    });
  });

  describe('resolveServer', () => {
    it('rejects non-loopback HTTP from a flag', async () => {
      const err = await expectRejects(
        () => resolveServer('http://10.0.0.5'),
        PreconditionError,
      );
      expect(err.code).to.equal('insecure-server-url');
    });

    it('rejects non-loopback HTTP from stored config', async () => {
      await writeConfig({ server: 'http://10.0.0.5' });
      const err = await expectRejects(() => resolveServer(), PreconditionError);
      expect(err.code).to.equal('insecure-server-url');
    });

    it('allows loopback HTTP', async () => {
      expect(await resolveServer('http://127.0.0.1:3000')).to.equal(
        'http://127.0.0.1:3000',
      );
    });

    it('uses the override when present', async () => {
      expect(await resolveServer('https://custom.example.com')).to.equal(
        'https://custom.example.com',
      );
    });

    it('falls back to config.server', async () => {
      await writeConfig({ server: 'https://stored.example.com' });
      expect(await resolveServer()).to.equal('https://stored.example.com');
    });

    it('falls back to the default when nothing is set', async () => {
      expect(await resolveServer()).to.equal(DEFAULT_SERVER);
    });

    it('--region flag maps to the production URL', async () => {
      expect(await resolveServer({ region: 'lon' })).to.equal(
        'https://production-lon.browserless.io',
      );
    });

    it('--region flag beats --server flag is rejected', async () => {
      await expectRejects(
        () => resolveServer({ region: 'lon', server: 'https://x.example.com' }),
        PreconditionError,
        /mutually exclusive/,
      );
    });

    it('--region flag beats config.region', async () => {
      await writeConfig({ region: 'sfo' });
      expect(await resolveServer({ region: 'ams' })).to.equal(
        'https://production-ams.browserless.io',
      );
    });

    it('--server flag beats config.region', async () => {
      await writeConfig({ region: 'sfo' });
      expect(await resolveServer({ server: 'https://x.example.com' })).to.equal(
        'https://x.example.com',
      );
    });

    it('config.region resolves to the production URL', async () => {
      await writeConfig({ region: 'ams' });
      expect(await resolveServer()).to.equal(
        'https://production-ams.browserless.io',
      );
    });

    it('config.region + config.server simultaneously errors', async () => {
      await writeConfig({ region: 'sfo', server: 'https://x.example.com' });
      await expectRejects(
        () => resolveServer(),
        PreconditionError,
        /Both "region" .* and "server"/,
      );
    });

    it('unknown region throws UsageError with the known list', async () => {
      const err = await expectRejects(
        () => resolveServer({ region: 'zzz' }),
        UsageError,
        /Unknown region "zzz"/,
      );
      expect(err.message).to.match(/Known regions:/);
    });
  });

  describe('resolveToken priority', () => {
    it('flag wins over everything', async () => {
      process.env.BROWSERLESS_TOKEN = 'env-tok';
      installFakeKeychain({ 'https://x.example.com': 'kc-tok' });
      await writeConfig({ api_key: 'file-tok' });
      const res = await resolveToken({
        flag: 'flag-tok',
        server: 'https://x.example.com',
      });
      expect(res).to.deep.equal({ token: 'flag-tok', source: 'flag' });
    });

    it('env wins over keychain + file', async () => {
      process.env.BROWSERLESS_TOKEN = 'env-tok';
      installFakeKeychain({ 'https://x.example.com': 'kc-tok' });
      await writeConfig({ api_key: 'file-tok' });
      const res = await resolveToken({ server: 'https://x.example.com' });
      expect(res.source).to.equal('env');
      expect(res.token).to.equal('env-tok');
    });

    it('keychain wins over file', async () => {
      installFakeKeychain({ 'https://x.example.com': 'kc-tok' });
      await writeConfig({ api_key: 'file-tok' });
      const res = await resolveToken({ server: 'https://x.example.com' });
      expect(res.source).to.equal('keychain');
      expect(res.token).to.equal('kc-tok');
    });

    it('falls back to file when keychain has no entry', async () => {
      installFakeKeychain();
      await writeConfig({ api_key: 'file-tok' });
      const res = await resolveToken({ server: 'https://x.example.com' });
      expect(res.source).to.equal('file');
      expect(res.token).to.equal('file-tok');
    });

    it('falls back to file when keychain is unavailable', async () => {
      installNoKeychain();
      await writeConfig({ api_key: 'file-tok' });
      const res = await resolveToken({ server: 'https://x.example.com' });
      expect(res.source).to.equal('file');
    });

    it('throws PreconditionError when nothing is configured', async () => {
      installNoKeychain();
      await expectRejects(
        () => resolveToken({ server: 'https://x.example.com' }),
        PreconditionError,
      );
    });

    it('throws when the keychain is present but read fails — does NOT fall through to file', async () => {
      // Without this branch, a locked keychain presents as "no entry"
      // and the CLI silently uses the plaintext fallback (or "no token"
      // error) — the user can't tell their stored token still exists.
      installThrowingKeychain('access denied');
      await writeConfig({ api_key: 'file-tok' });
      const err = await expectRejects(
        () => resolveToken({ server: 'https://x.example.com' }),
        PreconditionError,
        /Keychain.*read failed.*access denied/,
      );
      expect(err.message).to.match(/BROWSERLESS_DISABLE_KEYCHAIN/);
    });
  });

  describe('persistToken', () => {
    it('writes to the keychain when available', async () => {
      const kc = installFakeKeychain();
      const result = await persistToken({
        server: 'https://x.example.com',
        token: 'new-tok',
      });
      expect(result.mode).to.equal('keychain');
      expect(kc.setPassword.calledOnce).to.be.true;
      const args = kc.setPassword.firstCall.args;
      expect(args[1]).to.equal('https://x.example.com');
      expect(args[2]).to.equal('new-tok');
    });

    it('falls back to the config file when keychain is unavailable', async () => {
      installNoKeychain();
      const result = await persistToken({
        server: 'https://x.example.com',
        token: 'new-tok',
      });
      expect(result.mode).to.equal('file');
      expect(result.warning).to.match(/plaintext/);

      const res = await resolveToken({ server: 'https://x.example.com' });
      expect(res.source).to.equal('file');
      expect(res.token).to.equal('new-tok');
    });

    it('throws when the keychain is present but the write fails', async () => {
      installThrowingKeychain('access denied');
      const err = await expectRejects(
        () =>
          persistToken({
            server: 'https://x.example.com',
            token: 'new-tok',
          }),
        PreconditionError,
        /access denied/,
      );
      expect(err.message).to.match(/BROWSERLESS_DISABLE_KEYCHAIN/);

      // Plaintext file must not have been written as a fallback — verify
      // by switching to a no-keychain backend and asserting resolveToken
      // can't find anything.
      installNoKeychain();
      await expectRejects(
        () => resolveToken({ server: 'https://x.example.com' }),
        PreconditionError,
      );
    });
  });

  describe('clearToken', () => {
    it('removes from both keychain and config', async () => {
      const kc = installFakeKeychain({ 'https://x.example.com': 'kc-tok' });
      await writeConfig({ api_key: 'file-tok', token_storage: 'keychain' });
      await clearToken('https://x.example.com');
      expect(kc.deletePassword.calledOnce).to.be.true;
      installNoKeychain();
      await expectRejects(
        () => resolveToken({ server: 'https://x.example.com' }),
        PreconditionError,
      );
    });

    it('clears config even when there is no keychain entry to delete', async () => {
      installNoKeychain();
      await writeConfig({ api_key: 'file-tok', token_storage: 'file' });
      await clearToken('https://x.example.com');
      await expectRejects(
        () => resolveToken({ server: 'https://x.example.com' }),
        PreconditionError,
      );
    });

    it('throws when the keychain delete fails — does NOT wipe the config', async () => {
      // The plaintext config is left alone here intentionally: if we
      // wiped it after a failed keychain delete the user would see
      // "logged out" while the real token still lives in the keychain.
      await writeConfig({ api_key: 'file-tok', token_storage: 'keychain' });
      installThrowingKeychain('access denied');
      const err = await expectRejects(
        () => clearToken('https://x.example.com'),
        PreconditionError,
        /Could not delete/,
      );
      expect(err.message).to.match(/access denied/);

      // Switch to a no-keychain backend so resolveToken falls back to
      // the file path — and confirm the plaintext entry was preserved.
      installNoKeychain();
      const res = await resolveToken({ server: 'https://x.example.com' });
      expect(res.token).to.equal('file-tok');
      expect(res.source).to.equal('file');
    });
  });
});
