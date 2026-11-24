import { expect } from 'chai';
import { uploadProfile } from './upload.js';
import { refreshProfile } from './refresh.js';
import { ApiError } from '../errors.js';
import { startStubServer, StubServer } from '../test-helpers/stub-server.js';
import { expectRejects } from '../test-helpers/assertions.js';

const profileResponse = {
  id: 'profile_xyz',
  name: 'demo',
  cookieCount: 1,
  originCount: 0,
  lastUsedAt: null,
  createdAt: '2026-05-05T00:00:00Z',
  updatedAt: '2026-05-05T00:00:00Z',
};

describe('api/upload + api/refresh', () => {
  let stub: StubServer;
  beforeEach(async () => {
    stub = await startStubServer();
  });
  afterEach(async () => {
    await stub.close();
  });

  for (const write of [uploadProfile, refreshProfile]) {
    it(`${write.name} correlates via header, never body, and ignores malformed IDs`, async () => {
      stub.setResponse(200, JSON.stringify(profileResponse));
      const attemptId = '72d3a05a-1fc5-430a-994a-794e23236d37';
      for (const id of [attemptId, 'bad\r\nAuthorization: secret']) {
        await write(
          { server: stub.url, token: 't' },
          {
            name: 'demo',
            state: { cookies: [], origins: [] },
            attemptId: id,
          },
        );
      }
      expect(stub.recorded[0].headers['x-browserless-attempt-id']).to.equal(
        attemptId,
      );
      expect(stub.recorded[1].headers).not.to.have.property(
        'x-browserless-attempt-id',
      );
      expect(JSON.parse(stub.recorded[0].body)).not.to.have.property(
        'attemptId',
      );
    });
  }

  it('uploadProfile POSTs to /profile/upload with the captured state', async () => {
    stub.setResponse(200, JSON.stringify(profileResponse));
    const result = await uploadProfile(
      { server: stub.url, token: 't' },
      {
        name: 'demo',
        state: {
          cookies: [
            {
              name: 'k',
              value: 'v',
              domain: 'example.com',
              path: '/',
              expires: -1,
              size: 0,
              httpOnly: false,
              secure: false,
              session: false,
            },
          ],
          origins: [],
        },
      },
    );
    expect(stub.recorded[0].url).to.match(/^\/profile\/upload\?token=t/);
    const sent = JSON.parse(stub.recorded[0].body);
    expect(sent.name).to.equal('demo');
    expect(sent.state.cookies).to.have.length(1);
    expect(result.id).to.equal('profile_xyz');
  });

  it('uploadProfile reuses pre-serialized state', async () => {
    stub.setResponse(200, JSON.stringify(profileResponse));
    await uploadProfile(
      { server: stub.url, token: 't' },
      {
        name: 'demo',
        state: { cookies: [], origins: [] },
        serialized: '{"cookies":[],"origins":[]}',
      },
    );
    const sent = JSON.parse(stub.recorded[0].body);
    expect(sent).to.deep.equal({
      name: 'demo',
      state: { cookies: [], origins: [] },
    });
  });

  it('uploadProfile omits captureSettings entirely when not provided', async () => {
    stub.setResponse(200, JSON.stringify(profileResponse));
    await uploadProfile(
      { server: stub.url, token: 't' },
      { name: 'demo', state: { cookies: [], origins: [] } },
    );
    const sent = JSON.parse(stub.recorded[0].body);
    expect(sent).to.not.have.property('captureSettings');
  });

  it('uploadProfile emits captureSettings on the pre-serialized fast path', async () => {
    stub.setResponse(200, JSON.stringify(profileResponse));
    await uploadProfile(
      { server: stub.url, token: 't' },
      {
        name: 'demo',
        state: { cookies: [], origins: [] },
        serialized: '{"cookies":[],"origins":[]}',
        captureSettings: {
          browser: 'chrome',
          profile: 'Default',
          excludeDomains: ['chase.com'],
          autoFit: true,
          cliVersion: '9.9.9',
        },
      },
    );
    const sent = JSON.parse(stub.recorded[0].body);
    expect(sent).to.deep.equal({
      name: 'demo',
      state: { cookies: [], origins: [] },
      captureSettings: {
        browser: 'chrome',
        profile: 'Default',
        excludeDomains: ['chase.com'],
        autoFit: true,
        cliVersion: '9.9.9',
      },
    });
  });

  /**
   * The wire is where the empty-list decision actually lands, and it was pinned only at
   * the two ends — the builder and the server's parser. `buildProfileBody` hand-writes
   * the JSON, so any payload-shrinking tweak (a replacer dropping empty arrays to fight
   * the 8 KB cap) would emit no `excludeDomains` at all; the server would then store
   * "unknown" and the next flagless refresh would re-apply the refreshing machine's own
   * config — a regression invisible to every unit spec on either side.
   */
  it('uploadProfile serializes an explicitly empty exclusion list', async () => {
    stub.setResponse(200, JSON.stringify(profileResponse));
    await uploadProfile(
      { server: stub.url, token: 't' },
      {
        name: 'demo',
        state: { cookies: [], origins: [] },
        serialized: '{"cookies":[],"origins":[]}',
        captureSettings: {
          browser: 'chrome',
          profile: 'Default',
          excludeDomains: [],
          cliVersion: '9.9.9',
        },
      },
    );
    const sent = JSON.parse(stub.recorded[0].body);
    expect(sent.captureSettings).to.have.property('excludeDomains');
    expect(sent.captureSettings.excludeDomains).to.deep.equal([]);
  });

  it('uploadProfile emits captureSettings on the JSON.stringify fallback path', async () => {
    stub.setResponse(200, JSON.stringify(profileResponse));
    await uploadProfile(
      { server: stub.url, token: 't' },
      {
        name: 'demo',
        state: { cookies: [], origins: [] },
        captureSettings: { browser: 'brave', cliVersion: '9.9.9' },
      },
    );
    const sent = JSON.parse(stub.recorded[0].body);
    expect(sent).to.deep.equal({
      name: 'demo',
      state: { cookies: [], origins: [] },
      captureSettings: { browser: 'brave', cliVersion: '9.9.9' },
    });
  });

  it('refreshProfile emits captureSettings through the shared body builder', async () => {
    stub.setResponse(200, JSON.stringify(profileResponse));
    await refreshProfile(
      { server: stub.url, token: 't' },
      {
        name: 'demo',
        state: { cookies: [], origins: [] },
        serialized: '{"cookies":[],"origins":[]}',
        captureSettings: { onlyDomains: ['mail.google.com'] },
      },
    );
    expect(stub.recorded[0].url).to.match(/^\/profile\/refresh\?token=t/);
    const sent = JSON.parse(stub.recorded[0].body);
    expect(sent.captureSettings).to.deep.equal({
      onlyDomains: ['mail.google.com'],
    });
  });

  // A server predating the key rejects the whole body with ajv's generic message.
  // Both verbs must name the real cause instead.
  it('translates the version-skew 400 into an actionable message on upload', async () => {
    stub.setResponse(
      400,
      JSON.stringify({
        message:
          'POST Body validation failed: must NOT have additional properties',
      }),
    );
    const err = await expectRejects(
      () =>
        uploadProfile(
          { server: stub.url, token: 't' },
          {
            name: 'demo',
            state: { cookies: [], origins: [] },
            captureSettings: { browser: 'chrome' },
          },
        ),
      ApiError,
      /rejected the profile capture settings/i,
    );
    expect(err.status).to.equal(400);
    expect(err.message).to.contain(stub.url);
    expect(err.code).to.equal('capture-settings-rejected');
    // The server's own text must survive, so the two skew cases stay distinguishable.
    expect(err.message).to.contain('must NOT have additional properties');
    // No downgrade advice: deploying the server is the only correct remedy.
    expect(err.message).to.not.match(/install .* older/i);
  });

  it('translates the version-skew 400 on refresh too', async () => {
    stub.setResponse(
      400,
      JSON.stringify({
        message:
          'POST Body validation failed: must NOT have additional properties',
      }),
    );
    const err = await expectRejects(
      () =>
        refreshProfile(
          { server: stub.url, token: 't' },
          {
            name: 'demo',
            state: { cookies: [], origins: [] },
            captureSettings: { browser: 'chrome' },
          },
        ),
      ApiError,
      /rejected the profile capture settings/i,
    );
    expect(err.status).to.equal(400);
  });

  it('leaves an unrelated 400 message untouched', async () => {
    stub.setResponse(
      400,
      JSON.stringify({ message: 'Profile "demo" already exists.' }),
    );
    const err = await expectRejects(
      () =>
        uploadProfile(
          { server: stub.url, token: 't' },
          { name: 'demo', state: { cookies: [], origins: [] } },
        ),
      ApiError,
      /already exists/,
    );
    expect(err.message).to.not.match(/rejected the profile capture settings/);
  });

  it('uploadProfile maps 400 duplicate-name to ApiError', async () => {
    stub.setResponse(
      400,
      JSON.stringify({ message: 'Profile "demo" already exists.' }),
    );
    const err = await expectRejects(
      () =>
        uploadProfile(
          { server: stub.url, token: 't' },
          { name: 'demo', state: { cookies: [], origins: [] } },
        ),
      ApiError,
      /already exists/,
    );
    expect(err.status).to.equal(400);
  });

  it('refreshProfile POSTs to /profile/refresh', async () => {
    stub.setResponse(200, JSON.stringify(profileResponse));
    await refreshProfile(
      { server: stub.url, token: 't' },
      { name: 'demo', state: { cookies: [], origins: [] } },
    );
    expect(stub.recorded[0].url).to.match(/^\/profile\/refresh\?token=t/);
  });

  it('refreshProfile maps 404 missing-profile to ApiError', async () => {
    stub.setResponse(404, JSON.stringify({ message: 'Profile not found' }));
    const err = await expectRejects(
      () =>
        refreshProfile(
          { server: stub.url, token: 't' },
          { name: 'demo', state: { cookies: [], origins: [] } },
        ),
      ApiError,
    );
    expect(err.status).to.equal(404);
  });
});
