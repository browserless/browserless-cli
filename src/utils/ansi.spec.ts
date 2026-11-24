import { expect } from 'chai';
import { dim, red, green, gray, colorsFor } from './ansi.js';

describe('utils/ansi', function () {
  const ESC = String.fromCharCode(27);
  let savedNoColor: string | undefined;
  let savedIsTTY: boolean | undefined;

  beforeEach(() => {
    savedNoColor = process.env.NO_COLOR;
    savedIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    // `isTTY` is a writable property on the stream — restore it.
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: savedIsTTY,
    });
  });

  it('emits ANSI escapes when TTY and NO_COLOR is unset', function () {
    delete process.env.NO_COLOR;
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    expect(dim('x')).to.equal(`${ESC}[2mx${ESC}[0m`);
    expect(red('x').startsWith(`${ESC}[31m`)).to.equal(true);
    expect(green('x').startsWith(`${ESC}[32m`)).to.equal(true);
    expect(gray('x').startsWith(`${ESC}[90m`)).to.equal(true);
  });

  it('suppresses color when NO_COLOR is set', function () {
    process.env.NO_COLOR = '1';
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    expect(dim('x')).to.equal('x');
    expect(red('x')).to.equal('x');
  });

  it('suppresses color when stdout is not a TTY', function () {
    delete process.env.NO_COLOR;
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
    expect(dim('x')).to.equal('x');
  });

  describe('colorsFor (stream-aware gating)', function () {
    const ESC = String.fromCharCode(27);
    const fakeStream = (isTTY: boolean) =>
      ({ isTTY }) as unknown as NodeJS.WriteStream;

    beforeEach(() => {
      delete process.env.NO_COLOR;
      // Force stdout to the OPPOSITE of the stream under test, proving the
      // decision keys off the passed stream — the --json-to-stderr bug.
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: false,
      });
    });

    it('colorizes when the target stream is a TTY (even if stdout is not)', function () {
      const c = colorsFor(fakeStream(true));
      expect(c.gray('x')).to.equal(`${ESC}[90mx${ESC}[0m`);
      expect(c.dim('x')).to.equal(`${ESC}[2mx${ESC}[0m`);
    });

    it('suppresses color when the target stream is not a TTY', function () {
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: true,
      });
      const c = colorsFor(fakeStream(false));
      expect(c.green('x')).to.equal('x');
      expect(c.red('x')).to.equal('x');
    });

    it('still honors NO_COLOR regardless of the target stream', function () {
      process.env.NO_COLOR = '1';
      const c = colorsFor(fakeStream(true));
      expect(c.dim('x')).to.equal('x');
    });
  });
});
