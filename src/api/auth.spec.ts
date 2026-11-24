import { expect } from 'chai';
import { validateToken } from './auth.js';
import { startStubServer, StubServer } from '../test-helpers/stub-server.js';

describe('api/auth.validateToken', () => {
  let stub: StubServer;
  beforeEach(async () => {
    stub = await startStubServer();
  });
  afterEach(async () => {
    await stub.close();
  });

  it('returns true on 200 from /profiles', async () => {
    stub.setResponse(200, '[]');
    expect(await validateToken({ server: stub.url, token: 't' })).to.be.true;
    expect(stub.recorded[0].url).to.match(/^\/profiles\?token=t&limit=1/);
  });

  it('returns false on 401', async () => {
    stub.setResponse(401, '{"message":"Unauthorized"}');
    expect(await validateToken({ server: stub.url, token: 't' })).to.be.false;
  });

  it('rethrows on 5xx', async () => {
    stub.setResponse(503, '{"message":"Server overloaded"}');
    let threw = false;
    try {
      await validateToken({ server: stub.url, token: 't' });
    } catch {
      threw = true;
    }
    expect(threw).to.be.true;
  });
});
