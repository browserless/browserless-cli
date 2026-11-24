import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { AgentClient, buildCliWsUrl } from './ws-client.js';
import { ApiError, PreconditionError } from '../errors.js';
import { expectRejects } from '../test-helpers/assertions.js';

/** Spin up an HTTP server that proxies WS upgrades to a `WebSocketServer`. */
const startWsServer = async (opts: {
  /** When set, reject upgrades with this HTTP status before the WS handshake. */
  rejectStatus?: number;
  rejectMessage?: string;
  /** Hook invoked with each accepted WebSocket. */
  onConnection?: (ws: WebSocket, req: http.IncomingMessage) => void;
}): Promise<{ url: string; close: () => Promise<void> }> => {
  const wss = new WebSocketServer({ noServer: true });
  if (opts.onConnection) wss.on('connection', opts.onConnection);

  const httpServer = http.createServer();
  httpServer.on('upgrade', (req, socket, head) => {
    if (opts.rejectStatus) {
      socket.write(
        `HTTP/1.1 ${opts.rejectStatus} ${opts.rejectMessage ?? (opts.rejectStatus === 401 ? 'Unauthorized' : 'Server Error')}\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve),
  );
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        httpServer.close(() => resolve());
      }),
  };
};

describe('agent/ws-client', function () {
  this.timeout(10_000);

  describe('buildCliWsUrl', function () {
    it('swaps http→ws and appends token', function () {
      const url = buildCliWsUrl('http://example.com', 'tok');
      const u = new URL(url);
      expect(u.protocol).to.equal('ws:');
      expect(u.host).to.equal('example.com');
      expect(u.pathname).to.equal('/chromium/cli');
      expect(u.searchParams.get('token')).to.equal('tok');
      expect(u.searchParams.has('profile')).to.equal(false);
    });

    it('swaps https→wss and trims trailing slashes', function () {
      const url = buildCliWsUrl('https://x.io///', 'tok');
      expect(url.startsWith('wss://x.io/chromium/cli?')).to.equal(true);
    });
  });

  describe('connect / frame routing', function () {
    let server: Awaited<ReturnType<typeof startWsServer>> | undefined;
    afterEach(async () => {
      await server?.close();
      server = undefined;
    });

    it('connects and re-emits inbound frames by type', async function () {
      const incoming: Array<{ type: string; payload: unknown }> = [];
      server = await startWsServer({
        onConnection: (ws) => {
          ws.send(JSON.stringify({ type: 'data', text: 'hello' }));
          ws.send(
            JSON.stringify({
              type: 'end',
              result: { success: true, reason_code: 'done' },
            }),
          );
        },
      });

      const client = new AgentClient({ server: server.url, token: 't' });
      client.on('data', (f) => incoming.push({ type: 'data', payload: f }));
      client.on('end', (f) => incoming.push({ type: 'end', payload: f }));

      await client.connect();
      // Give the server's outbound frames a tick to arrive.
      await new Promise((r) => setTimeout(r, 30));
      client.close();

      expect(incoming.map((i) => i.type)).to.deep.equal(['data', 'end']);
      expect((incoming[0].payload as { text?: string }).text).to.equal('hello');
      expect(
        (incoming[1].payload as { result?: { success?: boolean } }).result
          ?.success,
      ).to.equal(true);
    });

    it('re-emits a server error frame as agent_error (not the special error event)', async function () {
      server = await startWsServer({
        onConnection: (ws) => {
          ws.send(JSON.stringify({ type: 'error', message: 'boom' }));
        },
      });

      const client = new AgentClient({ server: server.url, token: 't' });
      const seen: unknown[] = [];
      client.on('agent_error', (f) => seen.push(f));
      // No 'error' listener attached. If handleMessage emitted the special
      // 'error' event with zero listeners, Node would throw here and the test
      // process would crash rather than fail cleanly.
      await client.connect();
      await new Promise((r) => setTimeout(r, 30));
      client.close();

      expect(seen).to.have.lengthOf(1);
      expect((seen[0] as { message?: string }).message).to.equal('boom');
    });

    it('emits agent_error on a post-connect transport failure (not a silent close)', async function () {
      // A fake WS that connects cleanly, then lets us emit a mid-session socket
      // 'error' deterministically — a real ECONNRESET race is too flaky to pin.
      class FakeWs extends EventEmitter {
        static OPEN = 1;
        readyState = 1;
        constructor() {
          super();
          setImmediate(() => this.emit('open'));
        }
        send() {}
        close() {}
        terminate() {}
      }

      const client = new AgentClient({
        server: 'http://127.0.0.1:1',
        token: 't',
        WebSocketImpl: FakeWs as unknown as typeof WebSocket,
      });
      const errors: Array<{
        code?: string;
        message?: string;
        retryable?: boolean;
      }> = [];
      client.on('agent_error', (f) => errors.push(f));
      await client.connect();
      // Mid-session transport failure after the connect promise has resolved.
      (client as unknown as { ws: EventEmitter }).ws.emit(
        'error',
        new Error('read ECONNRESET'),
      );

      expect(errors).to.have.lengthOf(1);
      expect(errors[0].code).to.equal('ws-error');
      expect(errors[0].message).to.equal('read ECONNRESET');
      expect(errors[0].retryable).to.equal(false);
    });

    it('re-emits an abnormal close (1011) as agent_error, not a clean close', async function () {
      server = await startWsServer({
        onConnection: (ws) => ws.close(1011, 'server error'),
      });

      const client = new AgentClient({ server: server.url, token: 't' });
      const errors: Array<{
        code?: string;
        message?: string;
        retryable?: boolean;
      }> = [];
      let closed = false;
      client.on('agent_error', (f) => errors.push(f));
      client.on('close', () => {
        closed = true;
      });
      await client.connect();
      await new Promise((r) => setTimeout(r, 60));

      expect(errors).to.have.lengthOf(1);
      expect(errors[0].code).to.equal('ws-closed-1011');
      expect(errors[0].retryable).to.equal(false);
      expect(errors[0].message).to.contain('server error');
      expect(closed).to.equal(false); // NOT surfaced as a clean close
    });

    it('emits a clean close on a graceful closure (1000)', async function () {
      server = await startWsServer({
        onConnection: (ws) => ws.close(1000),
      });

      const client = new AgentClient({ server: server.url, token: 't' });
      const errors: unknown[] = [];
      let closeFrame: { code?: number } | undefined;
      client.on('agent_error', (f) => errors.push(f));
      client.on('close', (f) => {
        closeFrame = f;
      });
      await client.connect();
      await new Promise((r) => setTimeout(r, 60));

      expect(errors).to.have.lengthOf(0);
      expect(closeFrame?.code).to.equal(1000);
    });

    it('sends start/send/stop control frames in JSON', async function () {
      const received: unknown[] = [];
      server = await startWsServer({
        onConnection: (ws) => {
          ws.on('message', (m) => received.push(JSON.parse(m.toString())));
        },
      });

      const client = new AgentClient({ server: server.url, token: 't' });
      await client.connect();
      client.start('hi');
      client.send('again');
      client.stop();
      await new Promise((r) => setTimeout(r, 30));
      client.close();

      expect(received).to.deep.equal([
        { type: 'start', prompt: 'hi' },
        { type: 'send', prompt: 'again' },
        { type: 'stop' },
      ]);
    });
  });

  describe('upgrade error mapping', function () {
    it('classifies a connection failure and an unopened socket', async () => {
      const client = new AgentClient({
        server: 'http://127.0.0.1:1',
        token: 't',
      });
      const err = await expectRejects(() => client.connect(), ApiError);
      expect(err.code).to.equal('websocket-failed');
      expect(err.status).to.equal(0);
      expect(() => client.send('test'))
        .to.throw(ApiError)
        .with.property('code', 'websocket-not-open');
      client.close();
    });

    let server: Awaited<ReturnType<typeof startWsServer>> | undefined;
    afterEach(async () => {
      await server?.close();
      server = undefined;
    });

    it('maps 401 → PreconditionError("invalid-token")', async function () {
      server = await startWsServer({
        rejectStatus: 401,
        rejectMessage: 'Unauthorized\tforged-status',
      });
      const client = new AgentClient({ server: server.url, token: 't' });
      const err = await expectRejects(
        () => client.connect(),
        PreconditionError,
      );
      expect(err.code).to.equal('invalid-token');
      expect(err.message).to.equal(
        'Authentication failed (HTTP 401 — Unauthorized\\u0009forged-status). Check your token and server.',
      );
    });

    it('maps non-auth upgrade rejections → ApiError', async function () {
      server = await startWsServer({
        rejectStatus: 500,
        rejectMessage: 'Server Error\tforged-status',
      });
      const client = new AgentClient({ server: server.url, token: 't' });
      const err = await expectRejects(() => client.connect(), ApiError);
      expect(err.status).to.equal(500);
      expect(err.code).to.be.undefined;
      expect(err.message).to.equal(
        'Server rejected the agent connection (HTTP 500 — Server Error\\u0009forged-status).',
      );
    });
  });
});
