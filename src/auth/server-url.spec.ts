import { expect } from 'chai';
import sinon from 'sinon';
import { PreconditionError, UsageError } from '../errors.js';
import { captureAndClear } from '../test-helpers/env.js';
import { ALLOW_INSECURE_ENV, assertSecureServerUrl } from './server-url.js';

describe('assertSecureServerUrl', () => {
  let restoreEnv: () => void;
  let stderr: sinon.SinonStub;

  beforeEach(() => {
    restoreEnv = captureAndClear([ALLOW_INSECURE_ENV]);
    stderr = sinon.stub(process.stderr, 'write').returns(true);
  });
  afterEach(() => {
    stderr.restore();
    restoreEnv();
  });

  for (const server of [
    'https://x.example.com',
    'HTTPS://X.example.com:443/path/',
    'http://localhost:3000',
    'http://app.localhost:3000',
    'http://127.10.20.30:3000',
    'http://[::1]:3000',
  ]) {
    it(`allows ${server} unchanged without warning even with override`, () => {
      process.env[ALLOW_INSECURE_ENV] = '1';
      expect(assertSecureServerUrl(server)).to.equal(server);
      expect(stderr.called).to.equal(false);
    });
  }

  for (const override of [undefined, 'true', '0']) {
    it(`rejects remote HTTP with override ${override}`, () => {
      if (override !== undefined) process.env[ALLOW_INSECURE_ENV] = override;
      expect(() => assertSecureServerUrl('http://10.0.0.5:3000'))
        .to.throw(
          PreconditionError,
          'Refusing to send your Browserless token over unencrypted http:// to 10.0.0.5:3000. Use https://, or set BROWSERLESS_ALLOW_INSECURE_HTTP=1 to override.',
        )
        .with.property('code', 'insecure-server-url');
      expect(stderr.called).to.equal(false);
    });
  }

  it('allows remote HTTP only with exact override and emits one host-only warning', () => {
    process.env[ALLOW_INSECURE_ENV] = '1';
    const server = 'http://10.0.0.5:3000/path?token=private';
    expect(assertSecureServerUrl(server)).to.equal(server);
    expect(stderr.args).to.deep.equal([
      [
        'warning: sending your Browserless token over unencrypted http:// to 10.0.0.5:3000 (BROWSERLESS_ALLOW_INSECURE_HTTP is set)\n',
      ],
    ]);
  });

  for (const server of [
    'http://localhost.example.com',
    'http://127.0.0.1.nip.io',
    'http://192.168.1.10',
    'http://server.local',
    'http://[::ffff:127.0.0.1]',
  ]) {
    it(`does not auto-allow ${server}`, () => {
      expect(() => assertSecureServerUrl(server)).to.throw(PreconditionError);
    });
  }

  for (const protocol of ['ws:', 'wss:', 'ftp:', 'file:']) {
    it(`rejects ${protocol} even with override`, () => {
      process.env[ALLOW_INSECURE_ENV] = '1';
      expect(() => assertSecureServerUrl(`${protocol}//x.example.com`))
        .to.throw(UsageError, `server must use https:// (got "${protocol}")`)
        .with.property('code', 'unsupported-server-scheme');
    });
  }

  it('reports malformed URLs as usage errors', () => {
    expect(() => assertSecureServerUrl('not a url'))
      .to.throw(UsageError, 'server must be a valid URL (got "not a url")')
      .with.property('code', 'invalid-server-url');
  });
});
