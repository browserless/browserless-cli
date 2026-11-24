import { expect } from 'chai';
import { Command } from 'commander';
import { setupTempHome, TempHome } from '../../test-helpers/temp-home.js';
import { startStubServer, StubServer } from '../../test-helpers/stub-server.js';
import {
  installFakeKeychain,
  uninstallFakeKeychain,
} from '../../test-helpers/mock-keychain.js';
import {
  getRecordedToken,
  _resetRecordedTokenForTests,
} from '../../telemetry/token-cache.js';
import { registerAuthLogin } from './login.js';

describe('auth login telemetry', () => {
  let home: TempHome;
  let stub: StubServer;

  beforeEach(async () => {
    home = await setupTempHome();
    stub = await startStubServer();
    installFakeKeychain({});
    _resetRecordedTokenForTests();
  });
  afterEach(async () => {
    uninstallFakeKeychain();
    await stub.close();
    await home.cleanup();
  });

  it('records the validated token so the login is tracked', async () => {
    // 200 on the GET /profiles probe → validateToken returns true.
    stub.setResponse(200, '[]');
    const program = new Command();
    program.exitOverride();
    registerAuthLogin(program);

    await program.parseAsync(['login', 'tok-login', '--server', stub.url], {
      from: 'user',
    });

    expect(getRecordedToken()).to.deep.equal({
      token: 'tok-login',
      server: stub.url,
    });
  });
});
