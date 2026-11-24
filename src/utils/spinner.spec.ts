import { expect } from 'chai';
import { Writable } from 'node:stream';
import { Spinner } from './spinner.js';

/** A `WriteStream`-like sink that records every write call for assertions. */
const makeSink = (opts: { isTTY: boolean; columns?: number }) => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(stream, { isTTY: opts.isTTY, columns: opts.columns ?? 120 });
  return { stream, chunks };
};

const ESC = String.fromCharCode(27);
const CLEAR = `\r${ESC}[K`;

describe('utils/spinner', function () {
  describe('TTY mode', function () {
    it('renders an initial frame and rewrites in place', function () {
      const { stream, chunks } = makeSink({ isTTY: true });
      // intervalMs: 0 disables the auto-redraw timer; we trigger frames by
      // calling set() repeatedly so the assertions are deterministic.
      const sp = new Spinner({ out: stream, isTTY: true, intervalMs: 0 });
      sp.set('goto url=https://x');
      expect(chunks.length).to.equal(1);
      expect(chunks[0].startsWith(CLEAR)).to.equal(true);
      expect(chunks[0]).to.contain('goto url=https://x');
      // First braille frame is cycled in.
      expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(chunks[0])).to.equal(true);
    });

    it('done() commits the line with a trailing newline so it persists', function () {
      const { stream, chunks } = makeSink({ isTTY: true });
      const sp = new Spinner({ out: stream, isTTY: true, intervalMs: 0 });
      sp.set('goto');
      sp.done('✓ goto');
      // The cleared row write + the newline commit show up in `chunks`.
      const joined = chunks.join('');
      expect(joined).to.contain(`${CLEAR}✓ goto`);
      expect(joined.endsWith('\n')).to.equal(true);
      // After committing, the spinner is no longer active — the next event
      // lands on a fresh row instead of overwriting this one.
      expect(sp.isActive()).to.equal(false);
    });

    it('clear() wipes the line and stops being active', function () {
      const { stream, chunks } = makeSink({ isTTY: true });
      const sp = new Spinner({ out: stream, isTTY: true, intervalMs: 0 });
      sp.set('goto');
      sp.clear();
      expect(sp.isActive()).to.equal(false);
      expect(chunks[chunks.length - 1]).to.equal(CLEAR);
    });

    it('clips overly-long labels to the terminal width', function () {
      const { stream, chunks } = makeSink({ isTTY: true, columns: 20 });
      const sp = new Spinner({ out: stream, isTTY: true, intervalMs: 0 });
      sp.set('a'.repeat(14) + '😀' + 'b'.repeat(200));
      const written = chunks[0];
      expect(written).to.equal(`${CLEAR}⠋ ${'a'.repeat(14)}😀…`);
    });

    it('keeps wide glyphs and combining sequences within the available terminal cells', function () {
      for (const [label, clipped] of [
        ['😀'.repeat(20), '😀'.repeat(8) + '…'],
        ['界'.repeat(20), '界'.repeat(8) + '…'],
        ['e\u0301'.repeat(20), 'e\u0301'.repeat(16) + '…'],
        ['👨‍👩‍👧'.repeat(20), '👨‍👩‍👧'.repeat(8) + '…'],
        ['\ud800'.repeat(20), '�'.repeat(16) + '…'],
        ['\udc00'.repeat(20), '�'.repeat(16) + '…'],
      ]) {
        const { stream, chunks } = makeSink({ isTTY: true, columns: 20 });
        const sp = new Spinner({ out: stream, intervalMs: 0 });
        sp.set([{ text: label, style: (text) => `${ESC}[2m${text}${ESC}[0m` }]);
        expect(chunks[0]).to.equal(`${CLEAR}⠋ ${ESC}[2m${clipped}${ESC}[0m`);
        sp.set('next');
        expect(chunks[1]).to.equal(`${CLEAR}⠙ next`);
        sp.done([
          { text: `✓ ${label}`, style: (text) => `${ESC}[32m${text}${ESC}[0m` },
        ]);
        expect(chunks[2]).to.equal(`${CLEAR}${ESC}[32m✓ ${clipped}${ESC}[0m`);
      }
    });

    it('does not clip a wide label that exactly fits the available cells', function () {
      const { stream, chunks } = makeSink({ isTTY: true, columns: 20 });
      const sp = new Spinner({ out: stream, intervalMs: 0 });
      const label = 'a'.repeat(15) + '😀';
      sp.set(label);
      expect(chunks[0]).to.equal(`${CLEAR}⠋ ${label}`);
    });

    it('keeps redraws responsive for oversized remote labels', function () {
      this.timeout(10_000);
      const { stream, chunks } = makeSink({ isTTY: true, columns: 20 });
      const sp = new Spinner({ out: stream, intervalMs: 0 });
      const label = '😀'.repeat(1_000_000);
      const start = performance.now();
      for (let i = 0; i < 5; i++) sp.set(label);
      expect(performance.now() - start).to.be.lessThan(1_000);
      expect(chunks[0]).to.equal(`${CLEAR}⠋ ${'😀'.repeat(8)}…`);
    });
  });

  describe('non-TTY fallback', function () {
    it('set() emits nothing (no in-flight noise when piped)', function () {
      const { stream, chunks } = makeSink({ isTTY: false });
      const sp = new Spinner({ out: stream, isTTY: false, intervalMs: 0 });
      sp.set('goto');
      expect(chunks).to.deep.equal([]);
    });

    it('done() emits one clean scrolling line per completed tool', function () {
      const { stream, chunks } = makeSink({ isTTY: false });
      const sp = new Spinner({ out: stream, isTTY: false, intervalMs: 0 });
      sp.set('goto');
      sp.done('✓ goto');
      expect(chunks).to.deep.equal(['✓ goto\n']);
    });

    it('clear() is a no-op (no escape sequences leak into piped output)', function () {
      const { stream, chunks } = makeSink({ isTTY: false });
      const sp = new Spinner({ out: stream, isTTY: false, intervalMs: 0 });
      sp.clear();
      expect(chunks).to.deep.equal([]);
      expect(sp.isActive()).to.equal(false);
    });
  });
});
