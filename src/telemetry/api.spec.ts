import { expect } from 'chai';
import sinon from 'sinon';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { startStubServer, StubServer } from '../test-helpers/stub-server.js';
import { version } from '../version.js';
import { isTrustedApiBase, postCliEvents } from './api.js';

const sampleEvent = {
  event_type: 'CLI Command Run',
  time: 1_750_000_000_000,
  event_properties: { command: 'profile list' },
};

describe('isTrustedApiBase', () => {
  for (const base of [
    'https://api.browserless.io',
    'https://sub.browserless.io',
    'https://browserless.io',
    'http://127.0.0.1:9',
    'http://localhost:4000',
    'https://[::1]:4000',
    'http://app.localhost:4000',
  ]) {
    it(`accepts ${base}`, () => {
      expect(isTrustedApiBase(base)).to.equal(true);
    });
  }
  for (const base of [
    'http://api.browserless.io',
    'https://browserless.io.evil.com',
    'https://evilbrowserless.io',
    'https://attacker.example',
    'http://10.0.0.5',
    'ftp://api.browserless.io',
    'not a url',
    '',
    'ftp://localhost',
    'https://api.browserless.io@attacker.example',
    'http://127.0.0.1.nip.io',
  ]) {
    it(`rejects ${JSON.stringify(base)}`, () => {
      expect(isTrustedApiBase(base)).to.equal(false);
    });
  }
});

describe('telemetry/api postCliEvents', () => {
  let stub: StubServer;
  beforeEach(async () => {
    stub = await startStubServer();
  });
  afterEach(async () => {
    await stub.close();
  });

  it('does not fetch an untrusted destination', async () => {
    const fetch = sinon.stub(globalThis, 'fetch').resolves(new Response('{}'));
    try {
      const ok = await postCliEvents([sampleEvent], {
        token: 'tok',
        baseUrl: 'https://attacker.example',
      });
      expect(fetch.callCount).to.equal(0);
      expect(ok).to.equal(false);
    } finally {
      fetch.restore();
    }
  });

  it('POSTs events to /v2/cli/events with a Bearer token', async () => {
    stub.setResponse(202, '{"success":true,"accepted":1,"rejected":0}');
    const ok = await postCliEvents([sampleEvent], {
      token: 'tok-123',
      baseUrl: stub.url,
    });

    expect(ok).to.equal(true);
    expect(stub.recorded).to.have.length(1);
    const req = stub.recorded[0];
    expect(req.method).to.equal('POST');
    expect(req.url).to.equal('/v2/cli/events');
    expect(req.headers.authorization).to.equal('Bearer tok-123');
    expect(req.headers['user-agent']).to.equal(
      `@browserless.io/cli/${version}`,
    );
    const parsed = JSON.parse(req.body);
    expect(parsed.events[0].event_type).to.equal('CLI Command Run');
  });

  it('never follows a redirect, so the token is sent only to the configured host', async () => {
    // Same-origin redirects keep the Authorization header under fetch, so a
    // redirect anywhere would re-send the token; refuse them like apiFetch does.
    const seen: Array<{ url?: string; auth?: string }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      if (req.url === '/v2/cli/events') {
        res.writeHead(307, { location: '/collector' });
        res.end();
        return;
      }
      res.writeHead(202);
      res.end('{}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const ok = await postCliEvents([sampleEvent], {
        token: 'tok-redirect',
        baseUrl: `http://127.0.0.1:${port}`,
      });
      expect(ok).to.equal(false);
      expect(seen.map((r) => r.url)).to.deep.equal(['/v2/cli/events']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('returns false (never throws) on a non-2xx response', async () => {
    stub.setResponse(401, '{"error":"Invalid API token"}');
    const ok = await postCliEvents([sampleEvent], {
      token: 'bad',
      baseUrl: stub.url,
    });
    expect(ok).to.equal(false);
  });

  it('returns false on connection refused (never throws)', async () => {
    // Bind then immediately close to get a port nothing is listening on.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const ok = await postCliEvents([sampleEvent], {
      token: 'tok',
      baseUrl: `http://127.0.0.1:${port}`,
    });
    expect(ok).to.equal(false);
  });

  it('is bounded by the timeout when the server never responds', async () => {
    // A server that accepts the connection but never replies — postCliEvents
    // must abort and resolve false within the timeout, never hang the process.
    const hung = http.createServer(() => {
      /* intentionally never responds */
    });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const { port } = hung.address() as AddressInfo;

    try {
      const startedAt = Date.now();
      const ok = await postCliEvents([sampleEvent], {
        token: 'tok',
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 200,
      });
      expect(ok).to.equal(false);
      // 2 s is deliberate slack, not a tight bound: it only needs to prove the
      // AbortController fired (vs hanging for fetch's ~30 s default). A tighter
      // bound near timeoutMs would flake on loaded CI runners — which the repo
      // forbids mitigating.
      expect(Date.now() - startedAt).to.be.lessThan(2_000);
    } finally {
      // Always release the listener, even if an assertion above fails.
      await new Promise<void>((resolve) => hung.close(() => resolve()));
    }
  });
});
