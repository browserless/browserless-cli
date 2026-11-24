import { expect } from 'chai';
import {
  assertCloudProfileName,
  deleteProfile,
  getProfile,
  listProfiles,
  renameProfile,
} from './profiles.js';
import { startStubServer, StubServer } from '../test-helpers/stub-server.js';
import { expectRejects } from '../test-helpers/assertions.js';
import { UsageError } from '../errors.js';

const sampleProfile = {
  id: 'profile_x',
  name: 'demo',
  cookieCount: 0,
  originCount: 0,
  lastUsedAt: null,
  createdAt: '2026-05-05T00:00:00Z',
  updatedAt: '2026-05-05T00:00:00Z',
};

describe('api/profiles', () => {
  describe('assertCloudProfileName', () => {
    for (const name of ['work', 'my.profile-1_x', '...', 'x'.repeat(255)]) {
      it(`accepts ${JSON.stringify(name)}`, () => {
        expect(assertCloudProfileName(name)).to.equal(name);
      });
    }
    for (const name of [
      '',
      'x'.repeat(256),
      'a b',
      'a\tb',
      ' work',
      'a/b',
      'a?b',
      'a#b',
      '.',
      '..',
    ]) {
      it(`rejects ${JSON.stringify(name)} as an exit-2 usage error`, () => {
        try {
          assertCloudProfileName(name);
          expect.fail('Expected invalid name to throw');
        } catch (error) {
          expect(error).to.be.instanceOf(UsageError);
          expect((error as UsageError).code).to.equal(
            'invalid-cloud-profile-name',
          );
          expect((error as UsageError).exitCode).to.equal(2);
        }
      });
    }
    it('escapes terminal controls in the validation message', () => {
      expect(() => assertCloudProfileName('bad\n\x1b[2J')).to.throw(
        '"bad\\u000a\\u001b[2J"',
      );
    });
  });

  let stub: StubServer;
  beforeEach(async () => {
    stub = await startStubServer();
  });
  afterEach(async () => {
    await stub.close();
  });

  it('listProfiles forwards limit + offset', async () => {
    stub.setResponse(200, '[]');
    await listProfiles(
      { server: stub.url, token: 't' },
      { limit: 5, offset: 10 },
    );
    const url = new URL('http://x' + stub.recorded[0].url);
    expect(url.searchParams.get('limit')).to.equal('5');
    expect(url.searchParams.get('offset')).to.equal('10');
  });

  it('getProfile encodes the name in the path', async () => {
    stub.setResponse(200, JSON.stringify(sampleProfile));
    await getProfile({ server: stub.url, token: 't' }, 'a b/c');
    expect(stub.recorded[0].url.startsWith('/profile/a%20b%2Fc')).to.be.true;
  });

  it('renameProfile sends the new name in the body', async () => {
    stub.setResponse(200, JSON.stringify({ ...sampleProfile, name: 'demo-2' }));
    await renameProfile({ server: stub.url, token: 't' }, 'demo', 'demo-2');
    expect(stub.recorded[0].method).to.equal('PUT');
    expect(JSON.parse(stub.recorded[0].body)).to.deep.equal({ name: 'demo-2' });
  });

  it('deleteProfile DELETEs and returns the response', async () => {
    stub.setResponse(200, JSON.stringify(sampleProfile));
    const res = await deleteProfile({ server: stub.url, token: 't' }, 'demo');
    expect(stub.recorded[0].method).to.equal('DELETE');
    expect(res.name).to.equal('demo');
  });

  for (const name of ['.', '..']) {
    it(`refuses the dot-segment profile name ${JSON.stringify(name)} before sending anything`, async () => {
      const client = { server: stub.url, token: 't' };
      await expectRejects(
        () => deleteProfile(client, name),
        UsageError,
        /not a valid profile name/,
      );
      await expectRejects(() => getProfile(client, name), UsageError);
      await expectRejects(() => renameProfile(client, name, 'x'), UsageError);
      expect(stub.recorded).to.have.length(0);
    });
  }
});
