import { expect } from 'chai';
import http from 'node:http';
import net from 'node:net';
import { ChildProcess, spawn } from 'node:child_process';
import { DetectedProfile } from '../browsers/discover.js';
import { CDP_PIPE_CLOSED, type CdpPipe } from './cdp-pipe.js';
import { CaptureError } from '../errors.js';
import { expectRejects } from '../test-helpers/assertions.js';
import {
  fetchCdpMetadata,
  killBrowser,
  launchBrowser,
  launchBrowserWithPipe,
  startAnsweringBrowser,
  waitForCdpPipe,
  pickFreePort,
  waitForDebuggerEndpoint,
  windowsSystemExe,
} from './launch.js';

describe('capture/launch', () => {
  describe('pickFreePort', () => {
    it('returns a port in the valid range', async () => {
      const port = await pickFreePort();
      expect(port).to.be.greaterThan(0);
      expect(port).to.be.lessThanOrEqual(65535);
    });

    it('returns a port we can actually bind to', async () => {
      const port = await pickFreePort();
      const srv = net.createServer();
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => resolve());
      });
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    });

    it('returns different ports across calls', async () => {
      // OS may reuse, but it's vanishingly rare on consecutive picks.
      const ports = await Promise.all([
        pickFreePort(),
        pickFreePort(),
        pickFreePort(),
      ]);
      expect(new Set(ports).size).to.be.greaterThan(1);
    });
  });

  describe('waitForDebuggerEndpoint', () => {
    it('resolves when /json/version + an inspectable target are reachable', async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url?.startsWith('/json/list')) {
          res.end(
            JSON.stringify([
              { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/x' },
            ]),
          );
        } else {
          res.end('{"Browser":"Chrome/x"}');
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve()),
      );
      const { port } = server.address() as net.AddressInfo;
      try {
        await waitForDebuggerEndpoint(port, 2_000);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('keeps waiting (times out) when /json/version is up but no inspectable target appears', async () => {
      // The exact Brave/Windows shape: DevTools HTTP is up, but /json/list
      // never yields a target with a webSocketDebuggerUrl.
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          req.url?.startsWith('/json/list') ? '[]' : '{"Browser":"Chrome/x"}',
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve()),
      );
      const { port } = server.address() as net.AddressInfo;
      let threw = false;
      try {
        await waitForDebuggerEndpoint(port, 400);
      } catch (err) {
        threw = true;
        expect(err).to.be.instanceOf(CaptureError);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      expect(threw).to.be.true;
    });

    it('throws CaptureError after timeout when nothing is listening', async () => {
      // Use a very short timeout against a port we know is free
      const port = await pickFreePort();
      let threw = false;
      try {
        await waitForDebuggerEndpoint(port, 300);
      } catch (err) {
        threw = true;
        expect(err).to.be.instanceOf(CaptureError);
      }
      expect(threw).to.be.true;
    });
  });

  describe('fetchCdpMetadata', () => {
    let server: http.Server;
    let port: number;
    let respond: (status: number, body: string) => void = () => undefined;

    beforeEach(async () => {
      server = http.createServer((_req, res) => respond(res.statusCode, ''));
      // Default handler: 200 with empty payload — overridden per test.
      server.removeAllListeners('request');
      server.on('request', (_req, res) => {
        const handler = respond as unknown as (
          req: http.IncomingMessage,
          res: http.ServerResponse,
        ) => void;
        handler(_req, res);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve()),
      );
      port = (server.address() as net.AddressInfo).port;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const setHandler = (
      handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    ) => {
      respond = handler as never;
    };

    it('parses a valid /json/version payload', async () => {
      setHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            Browser: 'Chrome/147.0',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc`,
          }),
        );
      });
      const meta = await fetchCdpMetadata(port);
      expect(meta.Browser).to.equal('Chrome/147.0');
      expect(meta.webSocketDebuggerUrl).to.match(/^ws:\/\/127\.0\.0\.1:/);
    });

    it('throws CaptureError on non-200', async () => {
      setHandler((_req, res) => {
        res.writeHead(503);
        res.end('overloaded');
      });
      await expectRejects(() => fetchCdpMetadata(port), CaptureError);
    });

    it('throws CaptureError when webSocketDebuggerUrl is missing', async () => {
      setHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'Chrome/147' }));
      });
      await expectRejects(() => fetchCdpMetadata(port), CaptureError);
    });

    it('throws CaptureError when Browser field is missing', async () => {
      setHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }));
      });
      await expectRejects(() => fetchCdpMetadata(port), CaptureError);
    });
  });

  describe('launchBrowser arg construction', () => {
    // launchBrowser is normally driven against the user's real Chrome
    // binary. For these tests we point binaryPath at the Node executable
    // — `spawn` populates `child.spawnargs` synchronously, so we can
    // inspect the argv we built *before* killing the child. Node will
    // reject Chrome flags and exit fast; we don't care.
    let kept: ChildProcess | null = null;
    const tearDown = async () => {
      if (kept) {
        try {
          kept.kill('SIGKILL');
        } catch {
          // already gone
        }
        kept = null;
      }
    };
    afterEach(tearDown);

    const fakeProfile = (): DetectedProfile => ({
      browserKey: 'test',
      browserDisplayName: 'Test',
      profileDirName: 'Default',
      profileDisplayName: 'Default',
      userDataDir: '/tmp/browserless-cli-test-fake-user-data-dir',
      profilePath: '/tmp/browserless-cli-test-fake-user-data-dir/Default',
      binaryPath: process.execPath,
    });

    const launchArgs = async (
      overrides: Partial<Parameters<typeof launchBrowser>[0]>,
    ): Promise<string[]> => {
      const result = await launchBrowser({
        profile: fakeProfile(),
        userDataDir: '/tmp/browserless-cli-test-fake-tmp',
        port: 12345,
        ...overrides,
      });
      kept = result.child;
      // spawnargs[0] is the binary path; the rest is what we built.
      return result.child.spawnargs.slice(1);
    };

    it('headless=true emits --headless=new and the suppression set', async () => {
      // CAPTURE_LAUNCH_ARGS is the privacy gate: running a copy of the
      // user's profile *without* these flags will let it talk to Chrome
      // Sync / Safe Browsing / etc. on the user's behalf and corrupt the
      // user's real-browser session. The gate must engage on headless=true.
      const args = await launchArgs({ headless: true });
      expect(args).to.include('--headless=new');
      expect(args).to.include('--disable-gpu');
      expect(args).to.include('--disable-sync');
      expect(args).to.include('--disable-background-networking');
      expect(args).to.include('--disable-blink-features=AutomationControlled');
      expect(args).to.include('--metrics-recording-only');
    });

    it('headless=false omits --headless=new and the entire suppression set', async () => {
      // `profile launch` is the interactive flow — the user opens a real
      // browser window against their real dir. Inheriting the capture
      // suppression set would silently disable Chrome Sync etc. for the
      // user's session.
      const args = await launchArgs({ headless: false });
      expect(args).to.not.include('--headless=new');
      expect(args).to.not.include('--disable-gpu');
      expect(args).to.not.include('--disable-sync');
      expect(args).to.not.include('--disable-background-networking');
      expect(args).to.not.include('--metrics-recording-only');
      expect(args).to.not.include(
        '--disable-blink-features=AutomationControlled',
      );
    });

    it('headless defaults to true when the flag is omitted', async () => {
      // The capture pipeline calls launchBrowser without a headless flag.
      // The default must keep the privacy gate engaged.
      const args = await launchArgs({});
      expect(args).to.include('--headless=new');
      expect(args).to.include('--disable-sync');
    });

    it('always includes the base launch flags regardless of headless', async () => {
      // The basics — debug port, user-data-dir, profile-directory, no
      // first-run / no default-browser-check — apply to both paths.
      for (const headless of [true, false]) {
        const args = await launchArgs({ headless });
        expect(args).to.include('--remote-debugging-port=12345');
        expect(args).to.include(
          '--user-data-dir=/tmp/browserless-cli-test-fake-tmp',
        );
        expect(args).to.include('--profile-directory=Default');
        expect(args).to.include('--no-first-run');
        expect(args).to.include('--no-default-browser-check');
        expect(args[args.length - 1]).to.equal('about:blank');
        await tearDown();
      }
    });
  });

  describe('launchBrowserWithPipe', () => {
    let kept: ChildProcess | null = null;
    afterEach(async () => {
      if (kept) await killBrowser(kept, 200);
      kept = null;
    });

    it('speaks CDP over a private pipe, never a TCP port', async () => {
      // A localhost debugging port lets any local process attach to the
      // headless copy of the profile and read its decrypted cookies; the
      // pipe is reachable only through the file descriptors the CLI holds.
      const result = await launchBrowserWithPipe({
        profile: {
          browserKey: 'test',
          browserDisplayName: 'Test',
          profileDirName: 'Default',
          profileDisplayName: 'Default',
          userDataDir: '/tmp/browserless-cli-test-fake-user-data-dir',
          profilePath: '/tmp/browserless-cli-test-fake-user-data-dir/Default',
          binaryPath: process.execPath,
        },
        userDataDir: '/tmp/browserless-cli-test-fake-tmp',
      });
      kept = result.child;
      const args = result.child.spawnargs.slice(1);

      expect(args).to.include('--remote-debugging-pipe');
      expect(
        args.some((a) => a.startsWith('--remote-debugging-port')),
      ).to.equal(false);
      expect(args).to.include('--headless=new');
      expect(
        result.child.stdio[3],
        'fd 3: commands to the browser',
      ).to.not.equal(null);
      expect(
        result.child.stdio[4],
        'fd 4: replies from the browser',
      ).to.not.equal(null);
      expect(result.cdp.send).to.be.a('function');
    });
  });

  describe('waitForCdpPipe', () => {
    it('re-sends the readiness probe when an early message goes unanswered', async () => {
      // A browser can drop a command that arrives while it is still starting.
      // One probe left pending for the whole budget would then time out a
      // browser that is actually up; re-sending recovers it.
      let calls = 0;
      const cdp = {
        send: () => {
          calls += 1;
          return calls === 1
            ? new Promise(() => undefined)
            : Promise.resolve({ targetInfos: [{ type: 'page' }] });
        },
      } as unknown as Parameters<typeof waitForCdpPipe>[0];

      const started = Date.now();
      await waitForCdpPipe(cdp, 5_000);

      expect(calls).to.be.greaterThan(1);
      expect(Date.now() - started).to.be.lessThan(4_000);
    });

    it('fails with cdp-timeout when the browser never answers', async () => {
      const cdp = {
        send: () => new Promise(() => undefined),
      } as unknown as Parameters<typeof waitForCdpPipe>[0];

      const err = await expectRejects(
        () => waitForCdpPipe(cdp, 300),
        CaptureError,
        /did not expose an inspectable target within 300ms/,
      );
      expect(err.code).to.equal('cdp-timeout');
    });
  });

  describe('startAnsweringBrowser', () => {
    type Reply = 'answers' | 'silent' | 'protocol-error' | 'closed';
    const fakeLaunch = (reply: Reply, exitCode: number | null = null) => {
      const state = { closed: false };
      const send = () => {
        if (reply === 'answers') return Promise.resolve({ targetInfos: [] });
        if (reply === 'protocol-error') {
          return Promise.reject(new Error('Target.getTargets: not allowed'));
        }
        if (reply === 'closed')
          return Promise.reject(new Error(CDP_PIPE_CLOSED));
        return new Promise(() => undefined);
      };
      return {
        child: { exitCode, signalCode: null } as unknown as ChildProcess,
        cdp: {
          send,
          close: () => {
            state.closed = true;
          },
        } as unknown as CdpPipe,
        state,
      };
    };
    const starter = (...launches: Array<ReturnType<typeof fakeLaunch>>) => {
      const queue = [...launches];
      const start = async () => {
        start.calls += 1;
        const next = queue.shift();
        if (!next) throw new Error('started too many browsers');
        return next;
      };
      start.calls = 0;
      return start;
    };
    const noKill = async () => {
      throw new Error('must not kill');
    };

    for (const reply of ['answers', 'protocol-error', 'closed'] as const) {
      it(`keeps the first browser when the pipe ${reply === 'answers' ? 'answers' : `reports ${reply}`}`, async () => {
        const first = fakeLaunch(reply);
        const start = starter(first);
        const got = await startAnsweringBrowser(start, {
          silenceMs: 1_000,
          kill: noKill,
        });
        expect(got).to.equal(first);
        expect(start.calls).to.equal(1);
      });
    }

    it('restarts, once, a browser that stays alive but silent', async () => {
      // Edge on a Linux CI runner occasionally came up without ever answering
      // its pipe, while a fresh launch answered in about a second.
      const first = fakeLaunch('silent');
      const second = fakeLaunch('silent');
      const start = starter(first, second);
      const killed: ChildProcess[] = [];
      let restarts = 0;
      const got = await startAnsweringBrowser(start, {
        silenceMs: 200,
        kill: async (child) => {
          killed.push(child);
        },
        onRestart: () => {
          restarts += 1;
        },
      });
      expect(got).to.equal(second);
      expect(start.calls).to.equal(2);
      expect(killed).to.deep.equal([first.child]);
      expect(first.state.closed).to.equal(true);
      expect(restarts).to.equal(1);
    });

    it('leaves a browser that already exited to the readiness wait', async () => {
      const first = fakeLaunch('silent', 1);
      const start = starter(first);
      const got = await startAnsweringBrowser(start, {
        silenceMs: 200,
        kill: noKill,
      });
      expect(got).to.equal(first);
      expect(start.calls).to.equal(1);
    });
  });

  describe('killBrowser', () => {
    it('makes a second call wait for the kill already in flight (POSIX-only)', async function () {
      // An interrupt's cleanup can kill the same browser that a restart is
      // already stopping. Returning early would let the process exit before the
      // SIGKILL, leaving a browser that ignores SIGTERM running.
      if (process.platform === 'win32') {
        this.skip();
        return;
      }
      const child = spawn(process.execPath, [
        '-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ]);
      await new Promise<void>((resolve) =>
        child.once('spawn', () => resolve()),
      );
      await new Promise((r) => setTimeout(r, 200));
      try {
        const first = killBrowser(child, 300);
        await killBrowser(child, 300);
        expect(child.signalCode).to.equal('SIGKILL');
        await first;
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    });

    it('returns immediately on a null child without throwing', async () => {
      await killBrowser(null as never);
    });

    it('is idempotent on a child that has already exited', async () => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      // Two consecutive kills must not throw.
      await killBrowser(child, 50);
      await killBrowser(child, 50);
    });

    it('signals a long-running child and returns as soon as it exits (race against grace)', async () => {
      // Long-running stub: a Node process that responds to SIGTERM cleanly.
      const child = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000)',
      ]);
      const start = Date.now();
      // Use a generous grace; expect early return because Node honors SIGTERM
      // within tens of ms. Pre-fix this slept the full 2 s — wasted wall clock.
      await killBrowser(child, 2_000);
      const elapsed = Date.now() - start;
      expect(elapsed).to.be.lessThan(1_500);
      expect(child.exitCode !== null || child.signalCode !== null).to.be.true;
    });

    it('respects the grace timeout when the child ignores SIGTERM (POSIX-only)', async function () {
      // Windows has no real signals — child.kill('SIGTERM') translates to
      // TerminateProcess and kills immediately, so a JS-level signal trap
      // can't keep the child alive. The Windows kill path goes through
      // taskkill /T /F instead, which is unconditionally forceful. The
      // "honor grace before escalating" semantics only apply on POSIX.
      if (process.platform === 'win32') {
        this.skip();
        return;
      }
      // Trap SIGTERM so the child stays alive past the grace, forcing the
      // SIGKILL path. Verifies we do wait the grace before escalating.
      const child = spawn(process.execPath, [
        '-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ]);
      // Wait for the child to actually start AND for its JS to evaluate so
      // the SIGTERM handler is installed before we kill it.
      await new Promise<void>((resolve) =>
        child.once('spawn', () => resolve()),
      );
      await new Promise((r) => setTimeout(r, 200));

      const start = Date.now();
      await killBrowser(child, 250);
      const elapsed = Date.now() - start;
      // 10ms slop for setTimeout drift on contended CI runners (Node's
      // timer wheel can fire a tick or two early under load).
      expect(elapsed).to.be.greaterThanOrEqual(240);
      try {
        // Node marks the child `killed` as soon as SIGTERM is delivered, so
        // the escalation must not key off that flag.
        expect(child.signalCode).to.equal('SIGKILL');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    });
  });
});

describe('capture/launch.windowsSystemExe', () => {
  it('resolves a system tool under %SystemRoot%, never the current directory', () => {
    expect(
      windowsSystemExe('taskkill.exe', { SystemRoot: 'D:\\WINDOWS' }),
    ).to.equal('D:\\WINDOWS\\System32\\taskkill.exe');
  });

  it('falls back to C:\\Windows when %SystemRoot% is unset', () => {
    expect(windowsSystemExe('taskkill.exe', {})).to.equal(
      'C:\\Windows\\System32\\taskkill.exe',
    );
  });
});
