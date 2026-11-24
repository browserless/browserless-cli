import { expect } from 'chai';
import { parseNonNegativeInt } from './client.js';
import { UsageError } from '../errors.js';

describe('cli-utils/client.parseNonNegativeInt', () => {
  // `Number()` is too permissive on its own — it accepts hex, exponent,
  // and whitespace literals. The helper exists specifically to reject
  // those because they round-trip through URL query params as a number
  // the user didn't intend (`--limit 0x10` becomes ?limit=16, not an error).

  describe('accepts', () => {
    it('plain decimal integers', () => {
      expect(parseNonNegativeInt('--n', '0')).to.equal(0);
      expect(parseNonNegativeInt('--n', '1')).to.equal(1);
      expect(parseNonNegativeInt('--n', '42')).to.equal(42);
      expect(parseNonNegativeInt('--n', '1000000')).to.equal(1000000);
    });

    it('integers with leading zeros (decimal — not octal)', () => {
      // JS `Number("010")` is 10 (decimal), not 8 (octal) — fine.
      expect(parseNonNegativeInt('--n', '010')).to.equal(10);
    });

    it('respects the `min` parameter for positive-only flags', () => {
      expect(parseNonNegativeInt('--limit', '1', 1)).to.equal(1);
      expect(parseNonNegativeInt('--limit', '100', 1)).to.equal(100);
    });
  });

  describe('rejects', () => {
    const cases: [string, string][] = [
      ['hex literal', '0x10'],
      ['scientific notation', '1e3'],
      ['negative scientific', '-1e3'],
      ['float', '1.5'],
      ['negative integer', '-5'],
      ['letters', 'abc'],
      ['NaN literal', 'NaN'],
      ['Infinity literal', 'Infinity'],
      ['leading whitespace', ' 5'],
      ['trailing whitespace', '5 '],
      ['surrounding whitespace', ' 5 '],
      ['empty string', ''],
      ['plus prefix', '+5'],
      ['just minus', '-'],
      ['comma thousands separator', '1,000'],
      ['period', '.'],
    ];

    for (const [label, raw] of cases) {
      it(`${label}: ${JSON.stringify(raw)}`, () => {
        let threw = false;
        try {
          parseNonNegativeInt('--n', raw);
        } catch (err) {
          threw = true;
          expect(err).to.be.instanceOf(UsageError);
          expect((err as UsageError).code).to.equal('invalid-integer-flag');
          expect((err as Error).message).to.include('--n must be');
          expect((err as Error).message).to.include(
            JSON.stringify(raw).slice(1, -1),
          );
        }
        expect(threw, `${JSON.stringify(raw)} should have been rejected`).to.be
          .true;
      });
    }
  });

  describe('min boundary', () => {
    it('rejects 0 when min=1', () => {
      let threw = false;
      try {
        parseNonNegativeInt('--limit', '0', 1);
      } catch (err) {
        threw = true;
        expect(err).to.be.instanceOf(UsageError);
        expect((err as Error).message).to.match(/positive integer/);
      }
      expect(threw).to.be.true;
    });

    it('accepts 0 when min=0 (default)', () => {
      expect(parseNonNegativeInt('--offset', '0')).to.equal(0);
    });

    it('error message uses "positive" when min>0, "non-negative" when min=0', () => {
      // Chai's `.throw(matcher)` asserts both that a throw happened AND
      // that the message matches — guards against the "no-throw silently
      // passes" trap that bare try/catch has.
      expect(() => parseNonNegativeInt('--limit', 'abc', 1)).to.throw(
        /positive integer/,
      );
      expect(() => parseNonNegativeInt('--offset', 'abc', 0)).to.throw(
        /non-negative integer/,
      );
    });
  });
});
