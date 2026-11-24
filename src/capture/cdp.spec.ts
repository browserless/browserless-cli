import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cookieFromCdp,
  enumerateLocalStorageOrigins,
  isPrivateCookieDomain,
  isPrivateOrigin,
  isTransportDeadError,
  isVendorNtpOrigin,
  runOriginCaptureLoop,
  withTimeout,
  captureViaCdp,
  COOKIE_READ_TIMEOUT_MS,
} from './cdp.js';
import sinon from 'sinon';
import type { CdpPipe, CdpSession } from './cdp-pipe.js';
import type { DetectedProfile } from '../browsers/discover.js';
import { CaptureError } from '../errors.js';
import { expectRejects } from '../test-helpers/assertions.js';
import { ProfileOriginStorage } from './types.js';

describe('capture/cdp', () => {
  describe('isPrivateCookieDomain', () => {
    const cases: [string, boolean][] = [
      ['example.com', false],
      ['.example.com', false],
      ['www.example.com', false],
      ['sub.example.co.uk', false],

      // localhost and friends
      ['localhost', true],
      ['.localhost', true],
      ['sub.localhost', true],

      // mDNS / corp-style suffixes (mirror server filter — these
      // commonly carry corp SSO state that must not leak)
      ['my-laptop.local', true],
      ['.my-laptop.local', true],
      ['service.internal', true],
      ['nested.svc.internal', true],

      // IPv4 literals — block all of them, even the public ranges. The
      // CLI uploads cookies to a *cloud* account; an IP-literal Host
      // cookie almost certainly won't apply there.
      ['127.0.0.1', true],
      ['192.168.1.10', true],
      ['10.0.0.5', true],
      ['8.8.8.8', true],

      // IPv6 literals — `includes(':')` catches all of these, both
      // bracketed and bare, regardless of whether the address is in a
      // private range. Same guard catches a port-suffixed hostname,
      // which would be a CDP / cookie shape bug elsewhere but we drop
      // it defensively here.
      ['[::1]', true],
      ['[fd00:beef:cafe::]', true],
      ['::1', true],
      ['2001:db8::1', true],
      ['localhost:8080', true],

      // Empty / pathological
      ['', true],
    ];

    for (const [input, expected] of cases) {
      it(`${JSON.stringify(input)} → ${expected}`, () => {
        expect(isPrivateCookieDomain(input)).to.equal(expected);
      });
    }
  });

  describe('isPrivateOrigin', () => {
    it('accepts public http(s) origins', () => {
      expect(isPrivateOrigin('https://example.com')).to.be.false;
      expect(isPrivateOrigin('http://example.com:8080')).to.be.false;
    });

    it('rejects non-http(s) schemes', () => {
      expect(isPrivateOrigin('file:///etc/passwd')).to.be.true;
      expect(isPrivateOrigin('ftp://example.com')).to.be.true;
      expect(isPrivateOrigin('chrome-extension://abc')).to.be.true;
      expect(isPrivateOrigin('data:,hello')).to.be.true;
      expect(isPrivateOrigin('javascript:void(0)')).to.be.true;
    });

    it('delegates to isPrivateCookieDomain for the hostname', () => {
      expect(isPrivateOrigin('http://localhost')).to.be.true;
      expect(isPrivateOrigin('https://service.internal')).to.be.true;
      expect(isPrivateOrigin('http://192.168.1.1')).to.be.true;
    });

    it('rejects unparseable origin strings defensively', () => {
      // A broken origin string must not slip through as "public" — the
      // safer default is to drop it.
      expect(isPrivateOrigin('not a url')).to.be.true;
      expect(isPrivateOrigin('')).to.be.true;
      expect(isPrivateOrigin('https://')).to.be.true;
    });
  });

  describe('cookieFromCdp', () => {
    const minimal = {
      name: 'session',
      value: 'xyz',
      domain: '.example.com',
      path: '/',
      expires: 1735689600,
      size: 12,
      httpOnly: true,
      secure: true,
      session: false,
    };

    it('copies all required fields verbatim', () => {
      const out = cookieFromCdp(minimal);
      expect(out).to.deep.equal(minimal);
    });

    it('coerces non-numeric expires to -1 (session cookie sentinel)', () => {
      const out = cookieFromCdp({ ...minimal, expires: 'never' });
      expect(out.expires).to.equal(-1);
    });

    it('only includes sameSite when CDP returned a value', () => {
      const withSameSite = cookieFromCdp({ ...minimal, sameSite: 'Lax' });
      expect(withSameSite.sameSite).to.equal('Lax');
      const without = cookieFromCdp({ ...minimal });
      expect(without).to.not.have.property('sameSite');
    });

    it('only includes sourceScheme when CDP returned a value', () => {
      const withScheme = cookieFromCdp({ ...minimal, sourceScheme: 'Secure' });
      expect(withScheme.sourceScheme).to.equal('Secure');
      const without = cookieFromCdp({ ...minimal });
      expect(without).to.not.have.property('sourceScheme');
    });

    it('only includes sourcePort when CDP returned a truthy port', () => {
      // A port of 0 would be falsy and is meaningless anyway — fine to omit.
      const withPort = cookieFromCdp({ ...minimal, sourcePort: 443 });
      expect(withPort.sourcePort).to.equal(443);
      const withoutPort = cookieFromCdp({ ...minimal });
      expect(withoutPort).to.not.have.property('sourcePort');
    });

    it('coerces httpOnly / secure / session to plain booleans', () => {
      // Some CDP impls emit `0`/`1`; the wire contract expects booleans.
      const out = cookieFromCdp({
        ...minimal,
        httpOnly: 1 as never,
        secure: 0 as never,
        session: 1 as never,
      });
      expect(out.httpOnly).to.equal(true);
      expect(out.secure).to.equal(false);
      expect(out.session).to.equal(true);
    });
  });

  describe('enumerateLocalStorageOrigins', () => {
    let temp: string;
    beforeEach(async () => {
      temp = await fs.mkdtemp(
        path.join(os.tmpdir(), 'browserless-cli-leveldb-'),
      );
      await fs.mkdir(path.join(temp, 'Local Storage', 'leveldb'), {
        recursive: true,
      });
    });
    afterEach(async () => {
      await fs.rm(temp, { recursive: true, force: true });
    });

    const writeLog = (filename: string, content: string) =>
      fs.writeFile(
        path.join(temp, 'Local Storage', 'leveldb', filename),
        content,
      );

    it('returns [] when the leveldb dir does not exist', async () => {
      const empty = await fs.mkdtemp(
        path.join(os.tmpdir(), 'browserless-cli-empty-'),
      );
      try {
        expect(await enumerateLocalStorageOrigins(empty)).to.deep.equal([]);
      } finally {
        await fs.rm(empty, { recursive: true, force: true });
      }
    });

    it('finds public origins in *.log / *.ldb files', async () => {
      // LevelDB keys look like `_https://example.com\x00\x01<key>` —
      // the scanner just URL-regexes the binary content.
      await writeLog('000003.log', '_https://example.com\x00\x01key1');
      await writeLog('000004.ldb', 'preamble https://second.example/ junk');
      const out = await enumerateLocalStorageOrigins(temp);
      expect(out.sort()).to.deep.equal([
        'https://example.com',
        'https://second.example',
      ]);
    });

    it('skips non-leveldb files in the directory', async () => {
      await writeLog('CURRENT', 'manifest pointer https://ignored.example/');
      await writeLog('LOCK', '');
      await writeLog('LOG.old', 'https://also-ignored.example/');
      await writeLog('000003.log', '_https://kept.example/\x00');
      const out = await enumerateLocalStorageOrigins(temp);
      expect(out).to.deep.equal(['https://kept.example']);
    });

    it('filters out private origins (localhost, IPv4 literals, internal)', async () => {
      await writeLog(
        '000003.log',
        'https://example.com http://localhost https://127.0.0.1 https://corp.internal',
      );
      const out = await enumerateLocalStorageOrigins(temp);
      expect(out).to.deep.equal(['https://example.com']);
    });

    it('filters out vendor NTP origins like ntp.msn.com', async () => {
      // Edge populates leveldb keys for ntp.msn.com on every new tab,
      // so a typical Edge profile will have URL-shaped bytes for it in
      // every .log file. We have to drop it at the scan step or the
      // headless renderer crashes on the navigation that follows.
      await writeLog(
        '000003.log',
        '_https://ntp.msn.com\x00 https://example.com',
      );
      const out = await enumerateLocalStorageOrigins(temp);
      expect(out).to.deep.equal(['https://example.com']);
    });

    it('deduplicates origins across files', async () => {
      await writeLog('a.log', 'https://example.com/a https://example.com/b');
      await writeLog('b.ldb', 'https://example.com/c https://other.example/');
      const out = await enumerateLocalStorageOrigins(temp);
      expect(out.sort()).to.deep.equal([
        'https://example.com',
        'https://other.example',
      ]);
    });

    it('skips subsequent files once the byte budget is exhausted', async () => {
      // The budget check fires *between* files (after `bytesRead` is
      // incremented), not mid-file. So an oversized first file reads in
      // full but bumps `bytesRead` past BUDGET, and the second file is
      // skipped entirely.
      const bigPrefix = 'x'.repeat(11 * 1024 * 1024);
      await writeLog('001.log', `${bigPrefix} https://first.example/`);
      await writeLog('002.log', 'https://second.example/');
      const out = await enumerateLocalStorageOrigins(temp);
      expect(out).to.deep.equal(['https://first.example']);
    });

    it('stops between files when cumulative size crosses the budget mid-suite', async () => {
      // Both files individually fit under BUDGET (10 MB), but their sum
      // exceeds it. After file 001 reads, bytesRead is ~6 MB; on the
      // 002 iteration the check is still under BUDGET, so it reads. On
      // 003 it bails. Pins the "between files, not mid-file" semantics
      // for a non-pathological input. Use 4-character padding so the
      // 6 MB string fits in V8 's small-string fast path quickly.
      const mid = 'x'.repeat(6 * 1024 * 1024);
      await writeLog('001.log', `${mid} https://one.example/`);
      await writeLog('002.log', `${mid} https://two.example/`);
      await writeLog('003.log', 'https://three.example/');
      const out = await enumerateLocalStorageOrigins(temp);
      // 'three.example' must be absent — the budget broke iteration
      // *between* files 002 and 003.
      expect(out.sort()).to.deep.equal([
        'https://one.example',
        'https://two.example',
      ]);
    });
  });

  describe('isVendorNtpOrigin', () => {
    it("flags Edge's ntp.msn.com as a vendor NTP", () => {
      expect(isVendorNtpOrigin('https://ntp.msn.com')).to.be.true;
      // Path / port shouldn't matter — hostname is the discriminant.
      expect(isVendorNtpOrigin('https://ntp.msn.com:443/foo')).to.be.true;
    });

    it('returns false for ordinary public origins', () => {
      expect(isVendorNtpOrigin('https://www.google.com')).to.be.false;
      expect(isVendorNtpOrigin('https://example.com')).to.be.false;
      // Substrings of the NTP host don't count — only an exact hostname
      // match. msn.com (without `ntp.`) is just regular MSN, not the NTP.
      expect(isVendorNtpOrigin('https://msn.com')).to.be.false;
      expect(isVendorNtpOrigin('https://www.msn.com')).to.be.false;
    });

    it('returns false for unparseable origins (lets the normal filters reject)', () => {
      expect(isVendorNtpOrigin('not a url')).to.be.false;
      expect(isVendorNtpOrigin('')).to.be.false;
    });
  });

  describe('isTransportDeadError', () => {
    const cases: [string, boolean][] = [
      // Canonical shapes we see when the headless browser dies — these
      // are the strings actually observed in the field report that
      // motivated the fail-fast guard. Keep them in sync with whatever
      // the OS / Node net layer surfaces.
      ['connect ECONNREFUSED 127.0.0.1:65046', true],
      ['write EPIPE', true],
      ['socket hang up', true],
      ['Error: ECONNREFUSED', true],
      // Case-insensitive — `chrome-remote-interface` sometimes lowercases.
      ['econnrefused', true],
      // The pipe transport's closed-browser error.
      ['CDP pipe closed', true],

      // Other CDP / capture errors must NOT trip the cascade counter,
      // or a noisy site would prematurely abort a healthy run.
      ['Navigation timeout exceeded', false],
      ['WebSocket disconnected', false],
      ['Target closed', false],
      ['Protocol error: not connected', false],
      ['', false],
    ];

    for (const [input, expected] of cases) {
      it(`${JSON.stringify(input)} → ${expected}`, () => {
        expect(isTransportDeadError(input)).to.equal(expected);
      });
    }
  });

  describe('withTimeout', () => {
    it('resolves with the inner value when it settles before the deadline', async () => {
      const inner = new Promise<string>((resolve) =>
        setTimeout(() => resolve('done'), 5),
      );
      const out = await withTimeout(inner, 200, 'inner');
      expect(out).to.equal('done');
    });

    it('rejects with a timeout error when the inner promise hangs past the deadline', async () => {
      // Promise that never resolves — the only way out is the timeout path.
      const hang = new Promise<string>(() => {});
      try {
        await withTimeout(hang, 25, 'stuck-op');
        expect.fail('expected withTimeout to reject');
      } catch (err) {
        expect((err as Error).message).to.match(
          /stuck-op timed out after 25ms/,
        );
      }
    });

    it('propagates the inner rejection when the inner promise rejects first', async () => {
      const fail = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('inner failure')), 5),
      );
      try {
        await withTimeout(fail, 200, 'inner');
        expect.fail('expected withTimeout to reject');
      } catch (err) {
        expect((err as Error).message).to.equal('inner failure');
      }
    });
  });

  describe('runOriginCaptureLoop', () => {
    const populated = (origin: string): ProfileOriginStorage => ({
      origin,
      localStorage: { k: 'v' },
    });

    it('captures all candidates when doCapture returns data for each', async () => {
      const origins = ['https://a.example', 'https://b.example'];
      const result = await runOriginCaptureLoop(origins, [], async (o) =>
        populated(o),
      );
      expect(result.origins.map((x) => x.origin)).to.deep.equal(origins);
      expect(result.failedOrigins).to.have.length(0);
      expect(result.capHit).to.be.false;
      expect(result.originCountSkippedByExclusion).to.equal(0);
    });

    it('does not call doCapture for private origins', async () => {
      let calls = 0;
      const result = await runOriginCaptureLoop(
        ['https://a.example', 'http://localhost', 'http://192.168.0.1'],
        [],
        async (o) => {
          calls++;
          return populated(o);
        },
      );
      expect(calls).to.equal(1);
      expect(result.origins.map((x) => x.origin)).to.deep.equal([
        'https://a.example',
      ]);
    });

    it('does not call doCapture for vendor NTP origins (ntp.msn.com)', async () => {
      // Belt-and-braces — enumerate already strips these, but the loop
      // also skips so any caller passing a hand-built candidate list
      // can't sneak the crashing origin past us.
      let calls = 0;
      const result = await runOriginCaptureLoop(
        ['https://ntp.msn.com', 'https://a.example'],
        [],
        async (o) => {
          calls++;
          return populated(o);
        },
      );
      expect(calls).to.equal(1);
      expect(result.origins.map((x) => x.origin)).to.deep.equal([
        'https://a.example',
      ]);
    });

    it('caps attempts (not successful captures) so progress never overshoots', async () => {
      // Regression for the `70/50` display bug. With cap-on-successes,
      // 75 candidates that all returned null would attempt every one.
      // Cap-on-attempts stops at exactly the run-budget worth of CDP
      // round-trips no matter how many of them happen to yield data.
      const candidates = Array.from(
        { length: 75 },
        (_, i) => `https://o${i}.example`,
      );
      let calls = 0;
      const result = await runOriginCaptureLoop(candidates, [], async () => {
        calls++;
        // Always return null: no localStorage, no IndexedDB — the
        // origin contributes nothing to `origins[]`.
        return null;
      });
      // The cap (MAX_ORIGINS_PER_RUN = 50) is a private constant; the
      // observable contract is that doCapture is called *at most* the
      // budget many times and the run reports the cap was hit.
      expect(calls).to.equal(50);
      expect(result.capHit).to.be.true;
      expect(result.origins).to.have.length(0);
    });

    it('skips non-matching origins pre-navigation when --only-domain is set, without burning cap budget', async () => {
      // Cap is 50, we feed 60 unrelated origins + 1 imdb origin. Without
      // the pre-filter, the loop would burn the cap on unrelated origins
      // and never reach imdb. With it, only imdb gets a CDP attempt.
      const unrelated = Array.from(
        { length: 60 },
        (_, i) => `https://other-${i}.example`,
      );
      const candidates = [...unrelated, 'https://imdb.com'];
      const attemptedOrigins: string[] = [];
      const result = await runOriginCaptureLoop(
        candidates,
        [],
        async (o) => {
          attemptedOrigins.push(o);
          return populated(o);
        },
        undefined,
        ['imdb.com'],
      );
      expect(attemptedOrigins).to.deep.equal(['https://imdb.com']);
      expect(result.origins.map((x) => x.origin)).to.deep.equal([
        'https://imdb.com',
      ]);
      expect(result.originCountSkippedByOnlyDomain).to.equal(60);
      expect(result.capHit).to.be.false;
    });

    it('skips origins matching the exclusion list and counts them', async () => {
      let calls = 0;
      const result = await runOriginCaptureLoop(
        ['https://a.example', 'https://chase.com', 'https://b.example'],
        ['chase.com'],
        async (o) => {
          calls++;
          return populated(o);
        },
      );
      expect(calls).to.equal(2);
      expect(result.originCountSkippedByExclusion).to.equal(1);
      expect(result.origins.map((x) => x.origin)).to.deep.equal([
        'https://a.example',
        'https://b.example',
      ]);
    });

    it('drops origins where doCapture returns null', async () => {
      // doCapture returns null when the origin has no localStorage / IDB
      // worth keeping. The loop must not add a null entry to `origins`.
      const result = await runOriginCaptureLoop(
        ['https://a.example', 'https://b.example'],
        [],
        async (o) => (o.includes('a.') ? populated(o) : null),
      );
      expect(result.origins.map((x) => x.origin)).to.deep.equal([
        'https://a.example',
      ]);
    });

    it('collects per-origin failures alongside successes', async () => {
      const result = await runOriginCaptureLoop(
        ['https://a.example', 'https://b.example', 'https://c.example'],
        [],
        async (o) => {
          if (o.includes('b.')) throw new Error('Navigation timeout');
          return populated(o);
        },
      );
      expect(result.origins.map((x) => x.origin)).to.deep.equal([
        'https://a.example',
        'https://c.example',
      ]);
      expect(result.failedOrigins).to.have.length(1);
      expect(result.failedOrigins[0]).to.include({
        origin: 'https://b.example',
        kind: 'navigation-timeout',
      });
    });

    describe('fail-fast on consecutive transport-dead errors', () => {
      it('aborts at the 3rd consecutive ECONNREFUSED with browser-crashed code', async () => {
        // Reproduces the field-reported cascade: the headless browser
        // dies on origin 1, every subsequent CDP connection refuses. The
        // loop must bail at attempt 3 instead of logging 14 identical
        // failures.
        const origins = [
          'https://a.example',
          'https://b.example',
          'https://c.example',
          'https://d.example',
        ];
        let attempts = 0;
        try {
          await runOriginCaptureLoop(origins, [], async () => {
            attempts++;
            throw new Error('connect ECONNREFUSED 127.0.0.1:65046');
          });
          expect.fail('Expected CaptureError');
        } catch (err) {
          expect(err).to.be.instanceOf(CaptureError);
          expect((err as CaptureError).code).to.equal(
            'browser-crashed-during-capture',
          );
          expect((err as Error).message).to.match(/crashed mid-capture/);
        }
        // Bailed at the 3rd attempt — must not have called doCapture for
        // the 4th. Off-by-one here would defeat the whole point of the
        // fail-fast.
        expect(attempts).to.equal(3);
      });

      it('treats EPIPE the same as ECONNREFUSED for cascade counting', async () => {
        try {
          await runOriginCaptureLoop(
            ['a', 'b', 'c'].map((s) => `https://${s}.example`),
            [],
            async () => {
              throw new Error('write EPIPE');
            },
          );
          expect.fail('Expected CaptureError');
        } catch (err) {
          expect(err).to.be.instanceOf(CaptureError);
          expect((err as CaptureError).code).to.equal(
            'browser-crashed-during-capture',
          );
        }
      });

      it('does NOT fail-fast when a transport-dead error is followed by a success', async () => {
        // Sequence: ECONNREFUSED, success, ECONNREFUSED, ECONNREFUSED.
        // The success resets the counter, so the second cluster only
        // reaches 2 consecutive — under the threshold of 3.
        let i = 0;
        const result = await runOriginCaptureLoop(
          [
            'https://a.example',
            'https://b.example',
            'https://c.example',
            'https://d.example',
          ],
          [],
          async (o) => {
            i++;
            if (i === 1 || i === 3 || i === 4) {
              throw new Error('ECONNREFUSED');
            }
            return populated(o);
          },
        );
        expect(result.origins.map((x) => x.origin)).to.deep.equal([
          'https://b.example',
        ]);
        expect(result.failedOrigins).to.have.length(3);
      });

      it('does NOT fail-fast when transport errors are interleaved with non-transport errors', async () => {
        // ECONNREFUSED, ECONNREFUSED, timeout, ECONNREFUSED, ECONNREFUSED.
        // The non-transport timeout resets the counter, so neither cluster
        // reaches 3 consecutive. With 0 successes the loop ultimately
        // throws all-origins-failed, not the cascade error.
        const errs = [
          'ECONNREFUSED',
          'ECONNREFUSED',
          'Navigation timeout',
          'ECONNREFUSED',
          'ECONNREFUSED',
        ];
        let i = 0;
        try {
          await runOriginCaptureLoop(
            errs.map((_, idx) => `https://o${idx}.example`),
            [],
            async () => {
              throw new Error(errs[i++]);
            },
          );
          expect.fail('Expected CaptureError');
        } catch (err) {
          expect(err).to.be.instanceOf(CaptureError);
          expect((err as CaptureError).code).to.equal('all-origins-failed');
        }
      });
    });

    describe('abort when every attempted origin failed', () => {
      it('throws all-origins-failed when 0 succeed and ≥1 fail', async () => {
        try {
          await runOriginCaptureLoop(
            ['https://a.example', 'https://b.example'],
            [],
            async () => {
              throw new Error('Navigation timeout');
            },
          );
          expect.fail('Expected CaptureError');
        } catch (err) {
          expect(err).to.be.instanceOf(CaptureError);
          expect((err as CaptureError).code).to.equal('all-origins-failed');
          expect((err as Error).message).to.match(/All 2 attempted origin/);
          expect((err as Error).message).to.include('Sample:');
        }
      });

      it('does NOT throw when 0 candidates were attempted (empty profile)', async () => {
        // A genuinely empty profile has no leveldb origins to scan. That
        // is normal, not an error — many profiles only have cookies. The
        // all-failed check must not turn this into a thrown error.
        const result = await runOriginCaptureLoop([], [], async () => null);
        expect(result.origins).to.have.length(0);
        expect(result.failedOrigins).to.have.length(0);
      });

      it('does NOT throw when every candidate was skipped pre-navigation', async () => {
        // Two candidates filtered as private + one filtered by exclusion
        // list. doCapture must never be invoked, so failedOrigins stays
        // empty and the all-failed throw doesn't fire.
        let calls = 0;
        const result = await runOriginCaptureLoop(
          ['http://localhost', 'https://chase.com', 'https://[::1]'],
          ['chase.com'],
          async () => {
            calls++;
            return null;
          },
        );
        expect(calls).to.equal(0);
        expect(result.origins).to.have.length(0);
        expect(result.failedOrigins).to.have.length(0);
        expect(result.originCountSkippedByExclusion).to.equal(1);
      });

      it('does NOT throw when at least one origin succeeded', async () => {
        const result = await runOriginCaptureLoop(
          ['https://a.example', 'https://b.example'],
          [],
          async (o) => {
            if (o.includes('b.')) throw new Error('Navigation timeout');
            return populated(o);
          },
        );
        expect(result.origins).to.have.length(1);
        expect(result.failedOrigins).to.have.length(1);
      });

      it('error message lists up to 3 sample failures plus overflow count', async () => {
        try {
          await runOriginCaptureLoop(
            ['a', 'b', 'c', 'd', 'e'].map((s) => `https://${s}.example`),
            [],
            async (o) => {
              throw new Error(`oops on ${o}`);
            },
          );
          expect.fail('Expected CaptureError');
        } catch (err) {
          const msg = (err as Error).message;
          expect(msg).to.include('https://a.example');
          expect(msg).to.include('https://b.example');
          expect(msg).to.include('https://c.example');
          expect(msg).not.to.include('https://d.example');
          expect(msg).to.include('(+2 more)');
        }
      });
    });
  });

  describe('captureViaCdp cookie read', () => {
    it('fails with cdp-timeout instead of hanging when the browser stops answering', async () => {
      const clock = sinon.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout'],
      });
      try {
        const cdp = {
          send: () => new Promise(() => undefined),
        } as unknown as CdpPipe;
        const profile = {
          profilePath: '/nonexistent',
        } as unknown as DetectedProfile;

        const outcome = captureViaCdp(profile, cdp).then(
          () => null,
          (err: unknown) => err,
        );
        await clock.tickAsync(COOKIE_READ_TIMEOUT_MS + 1);
        const err = await outcome;

        expect(err).to.be.instanceOf(CaptureError);
        expect((err as CaptureError).code).to.equal('cdp-timeout');
      } finally {
        clock.restore();
      }
    });
  });

  describe('captureViaCdp over the pipe', () => {
    let profileDir: string;
    beforeEach(async () => {
      profileDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'browserless-cli-pipe-'),
      );
      await fs.mkdir(path.join(profileDir, 'Local Storage', 'leveldb'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(profileDir, 'Local Storage', 'leveldb', '000003.log'),
        '_https://a.example\x00\x01key',
      );
    });
    afterEach(async () => {
      await fs.rm(profileDir, { recursive: true, force: true });
    });

    it('leaves no unhandled rejection when navigation fails and the pipe later closes', async () => {
      // A pending Page.loadEventFired wait outlives a failed navigation; the
      // pipe closing when the browser is killed then rejects it. Unhandled,
      // that rejection would crash the CLI after the capture already failed.
      const closeWaits: Array<(err: Error) => void> = [];
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);

      const tab: CdpSession = {
        send: (async (method: string) => {
          if (method === 'Page.navigate') {
            throw new Error('Page.navigate: net::ERR_ABORTED');
          }
          return {};
        }) as CdpSession['send'],
        on: () => () => undefined,
        once: () =>
          new Promise((_, reject) => {
            closeWaits.push(reject);
          }),
      };
      const browserLevel: Record<string, unknown> = {
        'Storage.getCookies': { cookies: [] },
        'Target.createTarget': { targetId: 'T1' },
        'Target.attachToTarget': { sessionId: 'S1' },
      };
      const cdp = {
        ...tab,
        send: async (method: string) => browserLevel[method] ?? {},
        session: () => tab,
        close: () => undefined,
      } as unknown as CdpPipe;
      const profile = {
        profilePath: profileDir,
      } as unknown as DetectedProfile;

      try {
        await expectRejects(
          () => captureViaCdp(profile, cdp),
          CaptureError,
          /failed to capture/,
        );
        for (const reject of closeWaits) reject(new Error('CDP pipe closed'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).to.deep.equal([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });
});
