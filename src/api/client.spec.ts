import { expect } from 'chai';
import sinon from 'sinon';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { apiFetch } from './client.js';
import { uploadProfile } from './upload.js';
import { refreshProfile } from './refresh.js';
import { validateToken } from './auth.js';
import { ApiError } from '../errors.js';
import { startStubServer, StubServer } from '../test-helpers/stub-server.js';
import { expectRejects } from '../test-helpers/assertions.js';

describe('api/client', () => {
  let stub: StubServer;
  beforeEach(async () => {
    stub = await startStubServer();
  });
  afterEach(async () => {
    await stub.close();
  });

  it('appends the token as a query param', async () => {
    stub.setResponse(200, '{"ok":true}');
    await apiFetch(
      { server: stub.url, token: 'tok' },
      { method: 'GET', path: '/profiles' },
    );
    const url = new URL('http://x' + stub.recorded[0].url);
    expect(url.searchParams.get('token')).to.equal('tok');
  });

  it('serializes object body as JSON', async () => {
    stub.setResponse(200, '{}');
    await apiFetch(
      { server: stub.url, token: 'tok' },
      { method: 'POST', path: '/x', body: { a: 1 } },
    );
    expect(stub.recorded[0].headers['content-type']).to.equal(
      'application/json',
    );
    expect(JSON.parse(stub.recorded[0].body)).to.deep.equal({ a: 1 });
  });

  it('passes raw body through when provided', async () => {
    stub.setResponse(200, '{}');
    await apiFetch(
      { server: stub.url, token: 'tok' },
      { method: 'POST', path: '/x', rawBody: '{"raw":1}' },
    );
    expect(stub.recorded[0].body).to.equal('{"raw":1}');
  });

  it('forwards extra query params', async () => {
    stub.setResponse(200, '[]');
    await apiFetch(
      { server: stub.url, token: 'tok' },
      { method: 'GET', path: '/profiles', query: { limit: 10, offset: 20 } },
    );
    const url = new URL('http://x' + stub.recorded[0].url);
    expect(url.searchParams.get('limit')).to.equal('10');
    expect(url.searchParams.get('offset')).to.equal('20');
  });

  it('preserves a path prefix on the configured server URL', async () => {
    // Self-hosters behind a reverse proxy commonly set
    // `server=https://host.example/browserless/`. Without explicit
    // normalisation `new URL('/profile/upload', 'https://host/prefix/')`
    // drops the prefix; the path-relative form must survive.
    stub.setResponse(200, '{}');
    await apiFetch(
      { server: `${stub.url}/browserless`, token: 'tok' },
      { method: 'POST', path: '/profile/upload', body: { name: 'x' } },
    );
    expect(stub.recorded[0].url).to.match(/^\/browserless\/profile\/upload\?/);
  });

  it('preserves a path prefix when the configured server has a trailing slash', async () => {
    stub.setResponse(200, '{}');
    await apiFetch(
      { server: `${stub.url}/browserless/`, token: 'tok' },
      { method: 'GET', path: '/profiles' },
    );
    expect(stub.recorded[0].url).to.match(/^\/browserless\/profiles\?/);
  });

  it('drops undefined query values', async () => {
    stub.setResponse(200, '[]');
    await apiFetch(
      { server: stub.url, token: 'tok' },
      {
        method: 'GET',
        path: '/profiles',
        query: { limit: undefined, offset: 5 },
      },
    );
    const url = new URL('http://x' + stub.recorded[0].url);
    expect(url.searchParams.has('limit')).to.be.false;
    expect(url.searchParams.get('offset')).to.equal('5');
  });

  it('maps non-2xx to ApiError with server message', async () => {
    stub.setResponse(400, JSON.stringify({ message: 'name already exists' }));
    const err = await expectRejects(
      () =>
        apiFetch(
          { server: stub.url, token: 'tok' },
          { method: 'POST', path: '/profile/upload', body: { name: 'x' } },
        ),
      ApiError,
    );
    expect(err.status).to.equal(400);
    expect(err.message).to.equal('name already exists');
  });

  for (const [status, json] of [
    [400, true],
    [500, false],
    [200, false],
  ] as const) {
    it(`escapes ${status} ${json ? 'JSON' : 'text'} error fragments but keeps the raw body`, async () => {
      const hostile =
        'Not found\n✓ Profile "work" uploaded\r\n\t\x1b[2J\x9b\x7f';
      const body = json ? JSON.stringify({ message: hostile }) : hostile;
      stub.setResponse(status, body);
      const err = await expectRejects(
        () =>
          apiFetch(
            { server: stub.url, token: 'tok' },
            { method: 'GET', path: '/x' },
          ),
        ApiError,
      );
      expect(err.message).to.include(
        'Not found\\u000a✓ Profile "work" uploaded\\u000d\\u000a\\u0009\\u001b[2J\\u009b\\u007f',
      );
      expect(err.body).to.equal(body);
      expect(err.status).to.equal(status);
      expect(err.code).to.equal(
        status === 200 ? 'invalid-response' : undefined,
      );
    });
  }

  it('falls back to the raw body when error is not JSON', async () => {
    stub.setResponse(500, 'internal server error');
    await expectRejects(
      () =>
        apiFetch(
          { server: stub.url, token: 'tok' },
          { method: 'GET', path: '/x' },
        ),
      ApiError,
      /internal server error/,
    );
  });

  it('returns parsed JSON on 2xx', async () => {
    stub.setResponse(200, '{"id":"abc"}');
    const res = await apiFetch<{ id: string }>(
      { server: stub.url, token: 'tok' },
      { method: 'GET', path: '/profile/x' },
    );
    expect(res.id).to.equal('abc');
  });

  for (const [status, body, code] of [
    [200, 'not JSON', 'invalid-response'],
    [404, 'missing', undefined],
  ] as const) {
    it(`classifies the ${status} response`, async () => {
      stub.setResponse(status, body);
      const err = await expectRejects(
        () =>
          apiFetch(
            { server: stub.url, token: 'tok' },
            { method: 'GET', path: '/x' },
          ),
        ApiError,
      );
      expect(err.status).to.equal(status);
      expect(err.code).to.equal(code);
    });
  }

  it('returns undefined on 204', async () => {
    stub.setResponse(204, '');
    const res = await apiFetch<unknown>(
      { server: stub.url, token: 'tok' },
      { method: 'DELETE', path: '/profile/x' },
    );
    expect(res).to.be.undefined;
  });

  it('wraps network failures in ApiError with status 0', async () => {
    const err = await expectRejects(
      () =>
        apiFetch(
          { server: 'http://127.0.0.1:1', token: 'tok' },
          { method: 'GET', path: '/x' },
        ),
      ApiError,
    );
    expect(err.status).to.equal(0);
    expect(err.code).to.equal('network-unreachable');
  });

  describe('redirect handling', () => {
    let redirectServer: http.Server;
    let serverUrl: string;
    let status: number;
    let location: string;
    let receivedBodies: string[];

    beforeEach(async () => {
      receivedBodies = [];
      location = `${stub.url}/destination?token=synthetic-token`;
      redirectServer = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        receivedBodies.push(Buffer.concat(chunks).toString('utf-8'));
        res.writeHead(status, { Location: location });
        res.end();
      });
      await new Promise<void>((resolve) =>
        redirectServer.listen(0, '127.0.0.1', resolve),
      );
      serverUrl = `http://127.0.0.1:${(redirectServer.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) =>
        redirectServer.close(() => resolve()),
      );
    });

    for (const code of [301, 302, 303, 307, 308]) {
      for (const write of [uploadProfile, refreshProfile]) {
        it(`${write.name} refuses ${code} without sending profile data to the destination`, async () => {
          status = code;
          const state = {
            cookies: [
              {
                name: 'session',
                value: 'synthetic-cookie',
                domain: 'example.com',
                path: '/',
                expires: -1,
                size: 0,
                httpOnly: true,
                secure: true,
                session: true,
              },
            ],
            origins: [
              {
                origin: 'https://example.com',
                localStorage: { key: 'synthetic-storage' },
              },
            ],
          };
          const err = await expectRejects(
            () =>
              write(
                { server: serverUrl, token: 'synthetic-token' },
                { name: 'redirect-test', state },
              ),
            ApiError,
          );
          expect(err.status).to.equal(0);
          expect(receivedBodies).to.have.length(1);
          expect(JSON.parse(receivedBodies[0])).to.deep.equal({
            name: 'redirect-test',
            state,
          });
          expect(stub.recorded).to.have.length(0);
        });
      }
    }

    it('refuses relative same-origin redirects during token validation', async () => {
      status = 307;
      location = '/destination?token=synthetic-token';
      await expectRejects(
        () => validateToken({ server: serverUrl, token: 'synthetic-token' }),
        ApiError,
      );
      expect(receivedBodies).to.deep.equal(['']);
      expect(stub.recorded).to.have.length(0);
    });
  });

  describe('bounded response bodies', () => {
    let server: http.Server;
    let serverUrl: string;
    let handler: http.RequestListener;

    beforeEach(async () => {
      server = http.createServer((req, res) => handler(req, res));
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    for (const status of [200, 500]) {
      it(`rejects a gzip-decoded body over 10 MiB on HTTP ${status}`, async () => {
        const compressed = gzipSync(
          JSON.stringify('a'.repeat(10 * 1024 * 1024)),
        );
        expect(compressed.byteLength).to.be.lessThan(20_000);
        handler = (_req, res) => {
          res.writeHead(status, {
            'Content-Encoding': 'gzip',
            'Content-Length': compressed.byteLength,
          });
          res.end(compressed);
        };
        const err = await expectRejects(
          () =>
            apiFetch(
              { server: serverUrl, token: 'tok' },
              { method: 'GET', path: '/large' },
            ),
          ApiError,
        );
        expect(err.code).to.equal('response-too-large');
        expect(err.status).to.equal(0);
        expect(err.body).to.be.undefined;
      });
    }

    it('accepts exactly 10 MiB including UTF-8 characters split across chunks', async () => {
      const value = 'é' + 'a'.repeat(10 * 1024 * 1024 - 4);
      const body = Buffer.from(JSON.stringify(value));
      handler = (_req, res) => {
        res.write(body.subarray(0, 2));
        setImmediate(() => res.end(body.subarray(2)));
      };
      const result = await apiFetch<string>(
        { server: serverUrl, token: 'tok' },
        { method: 'GET', path: '/boundary' },
      );
      expect(result).to.equal(value);
    });

    it('rejects multibyte text by decoded bytes, not character count', async () => {
      handler = (_req, res) =>
        res.end(JSON.stringify('é'.repeat(6 * 1024 * 1024)));
      const err = await expectRejects(
        () =>
          apiFetch(
            { server: serverUrl, token: 'tok' },
            { method: 'GET', path: '/multibyte' },
          ),
        ApiError,
      );
      expect(err.code).to.equal('response-too-large');
    });

    it('cancels an overflowing chunked response before the server finishes', async () => {
      let completed = true;
      const closed = new Promise<void>((resolve) => {
        handler = (_req, res) => {
          res.on('close', () => {
            completed = res.writableEnded;
            resolve();
          });
          res.write(' '.repeat(10 * 1024 * 1024 + 1));
        };
      });
      const err = await expectRejects(
        () =>
          apiFetch(
            { server: serverUrl, token: 'tok' },
            { method: 'GET', path: '/endless', timeoutMs: 500 },
          ),
        ApiError,
      );
      expect(err.code).to.equal('response-too-large');
      await closed;
      expect(completed).to.be.false;
    });

    it('keeps the deadline active after headers while the body stalls', async () => {
      let finish: ReturnType<typeof setTimeout>;
      handler = (_req, res) => {
        res.writeHead(200);
        res.write('{');
        finish = setTimeout(() => res.end('}'), 500);
      };
      try {
        const err = await expectRejects(
          () =>
            apiFetch(
              { server: serverUrl, token: 'tok' },
              { method: 'GET', path: '/stalled-body', timeoutMs: 100 },
            ),
          ApiError,
        );
        expect(err.code).to.equal('request-timeout');
        expect(err.status).to.equal(0);
      } finally {
        clearTimeout(finish!);
      }
    });
  });

  describe('timeout handling', () => {
    for (const [name, code] of [
      ['AbortError', 'request-timeout'],
      ['Error', 'response-read-failed'],
    ]) {
      it(`classifies a response body ${name}`, async () => {
        const response = new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                Object.assign(new Error('read failed'), { name }),
              );
            },
          }),
        );
        const fetch = sinon.stub(globalThis, 'fetch').resolves(response);
        try {
          const err = await expectRejects(
            () =>
              apiFetch(
                { server: stub.url, token: 'tok' },
                { method: 'GET', path: '/x' },
              ),
            ApiError,
          );
          expect(err.code).to.equal(code);
          expect(err.status).to.equal(0);
        } finally {
          fetch.restore();
        }
      });
    }

    let slowServer: http.Server;
    let serverUrl: string;
    const pendingResponses: http.ServerResponse[] = [];

    beforeEach(async () => {
      // Hold every request open until the test tears the server down.
      // The AbortController in apiFetch is what we're trying to exercise;
      // we do not want the server to ever respond.
      slowServer = http.createServer((_req, res) => {
        pendingResponses.push(res);
      });
      await new Promise<void>((resolve) =>
        slowServer.listen(0, '127.0.0.1', () => resolve()),
      );
      const { port } = slowServer.address() as AddressInfo;
      serverUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      // Drain any held responses so close() can complete.
      for (const res of pendingResponses) {
        try {
          res.end();
        } catch {
          // already gone
        }
      }
      pendingResponses.length = 0;
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    });

    it('throws ApiError(status:0, "timed out after Xms") when the response stalls past timeoutMs', async () => {
      const start = Date.now();
      const err = await expectRejects(
        () =>
          apiFetch(
            { server: serverUrl, token: 'tok' },
            { method: 'GET', path: '/slow', timeoutMs: 100 },
          ),
        ApiError,
        /timed out after 100ms/,
      );
      expect(err.status).to.equal(0);
      expect(err.code).to.equal('request-timeout');
      expect(err.message).to.include(serverUrl);
      expect(err.message).to.include('/slow');
      // Must abort within ~timeoutMs + scheduler slop, not after the default
      // 30s. 2x is conservative; CI scheduler jitter on a contended runner
      // can push the actual abort 20-40ms past the deadline.
      expect(Date.now() - start).to.be.lessThan(2_000);
    });
  });
});
