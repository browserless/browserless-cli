import { expect } from 'chai';
import { ProfileAuthState } from '../capture/types.js';
import {
  formatBytes,
  measureOriginSizes,
  trimStateToFit,
} from './trim-state.js';

const makeOrigin = (origin: string, payloadBytes: number) => ({
  origin,
  localStorage: { padding: 'x'.repeat(payloadBytes) },
});

describe('cli-utils/trim-state', () => {
  describe('measureOriginSizes', () => {
    it('returns origins sorted by serialized byte size, heaviest first', () => {
      const state: ProfileAuthState = {
        cookies: [],
        origins: [
          makeOrigin('https://small.example', 10),
          makeOrigin('https://huge.example', 1000),
          makeOrigin('https://medium.example', 100),
        ],
      };
      const sizes = measureOriginSizes(state);
      expect(sizes.map((s) => s.origin)).to.deep.equal([
        'https://huge.example',
        'https://medium.example',
        'https://small.example',
      ]);
      expect(sizes[0].bytes).to.be.greaterThan(sizes[1].bytes);
      expect(sizes[1].bytes).to.be.greaterThan(sizes[2].bytes);
    });

    it('handles a state with no origins', () => {
      const state: ProfileAuthState = { cookies: [], origins: [] };
      expect(measureOriginSizes(state)).to.deep.equal([]);
    });
  });

  describe('trimStateToFit', () => {
    it('returns the state unchanged when it already fits', () => {
      const state: ProfileAuthState = {
        cookies: [],
        origins: [makeOrigin('https://small.example', 100)],
      };
      const result = trimStateToFit(state, 10_000);
      expect(result.dropped).to.deep.equal([]);
      expect(result.state).to.equal(state);
      expect(result.serialized).to.equal(JSON.stringify(state));
    });

    it('drops the heaviest origins first until the budget is met', () => {
      // A 1k + 2k + 5k state, target 4k → must drop the 5k one. Pads
      // include JSON overhead so the actual sizes are a bit higher.
      const state: ProfileAuthState = {
        cookies: [],
        origins: [
          makeOrigin('https://small.example', 1_000),
          makeOrigin('https://medium.example', 2_000),
          makeOrigin('https://huge.example', 5_000),
        ],
      };
      const result = trimStateToFit(state, 4_000);
      // huge.example is the only one big enough to push us over by itself.
      expect(result.dropped).to.deep.equal(['https://huge.example']);
      expect(result.state.origins.map((o) => o.origin).sort()).to.deep.equal(
        ['https://medium.example', 'https://small.example'],
      );
      expect(result.finalBytes).to.be.at.most(4_000);
    });

    it('preserves the survivors’ original order (not size order)', () => {
      // Originals: A=large, B=tiny, C=large. Drop the two larges; B
      // survives. With three larges and the tiny in the middle, dropping
      // A and C leaves B alone — but if we had B + D as survivors, the
      // returned order should match their original index, not size.
      const state: ProfileAuthState = {
        cookies: [],
        origins: [
          makeOrigin('https://first.example', 3_000),
          makeOrigin('https://second.example', 100),
          makeOrigin('https://third.example', 50),
          makeOrigin('https://fourth.example', 4_000),
        ],
      };
      const result = trimStateToFit(state, 800);
      // Both heavies dropped → survivors are second + third in original order.
      expect(result.state.origins.map((o) => o.origin)).to.deep.equal([
        'https://second.example',
        'https://third.example',
      ]);
      expect(result.dropped.sort()).to.deep.equal([
        'https://first.example',
        'https://fourth.example',
      ]);
    });

    it('drops every origin when even the cookies + envelope blow the budget', () => {
      // Budget = 5 bytes. Even {"cookies":[],"origins":[]} is ~27 bytes,
      // so the trim can't help. Every origin should still come out.
      const state: ProfileAuthState = {
        cookies: [],
        origins: [
          makeOrigin('https://a.example', 100),
          makeOrigin('https://b.example', 200),
        ],
      };
      const result = trimStateToFit(state, 5);
      expect(result.state.origins).to.have.length(0);
      expect(result.dropped.sort()).to.deep.equal([
        'https://a.example',
        'https://b.example',
      ]);
      // finalBytes will be the cookies + empty-origins envelope size,
      // still over budget — the caller is responsible for deciding
      // whether to proceed or bail.
      expect(result.finalBytes).to.be.greaterThan(5);
    });

    describe('keepPatterns', () => {
      it('protects matching origins, dropping the next-heaviest to make room', () => {
        // Heavy: tonscan (2k). Light: small (200). Budget 1k. Without
        // keep → drop tonscan → fits. With keep tonscan → tonscan stays,
        // small gets dropped instead (best-effort even if we don't
        // strictly need it). Final bytes still over budget because
        // tonscan alone exceeds it.
        const state: ProfileAuthState = {
          cookies: [],
          origins: [
            makeOrigin('https://tonscan.org', 2_000),
            makeOrigin('https://small.example', 200),
          ],
        };
        const result = trimStateToFit(state, 1_000, ['tonscan.org']);
        expect(result.state.origins.map((o) => o.origin)).to.deep.equal([
          'https://tonscan.org',
        ]);
        expect(result.dropped).to.deep.equal(['https://small.example']);
        expect(result.protectedFromDrop).to.deep.equal(['https://tonscan.org']);
        // We couldn't fit — caller will surface the protectedFromDrop list.
        expect(result.finalBytes).to.be.greaterThan(1_000);
      });

      it('uses suffix matching (so `example.com` protects `*.example.com`)', () => {
        // Same matching semantics as --exclude-domain. `google.com`
        // protects mail.google.com and accounts.google.com both — the
        // only droppable origin is small.example.
        const state: ProfileAuthState = {
          cookies: [],
          origins: [
            makeOrigin('https://mail.google.com', 5_000),
            makeOrigin('https://accounts.google.com', 4_000),
            makeOrigin('https://small.example', 1_000),
          ],
        };
        const result = trimStateToFit(state, 2_000, ['google.com']);
        // Only small.example is droppable; it gets dropped (best-effort)
        // even though removing it alone can't fit the budget — the two
        // google.com origins together are >9k.
        expect(result.dropped).to.deep.equal(['https://small.example']);
        expect(result.protectedFromDrop.sort()).to.deep.equal([
          'https://accounts.google.com',
          'https://mail.google.com',
        ]);
        expect(result.finalBytes).to.be.greaterThan(2_000);
      });

      it('actually fits under budget when the heaviest is droppable and the kept one is light', () => {
        // 5k huge (droppable) + 200 kept + 1k middle. Budget 2k.
        // Drop the 5k → fits. Kept origin never enters protectedFromDrop
        // because we hit budget before evaluating it.
        const state: ProfileAuthState = {
          cookies: [],
          origins: [
            makeOrigin('https://huge.example', 5_000),
            makeOrigin('https://kept.example', 200),
            makeOrigin('https://medium.example', 1_000),
          ],
        };
        const result = trimStateToFit(state, 2_000, ['kept.example']);
        expect(result.dropped).to.deep.equal(['https://huge.example']);
        expect(result.protectedFromDrop).to.deep.equal([]);
        expect(result.finalBytes).to.be.at.most(2_000);
      });

      it('treats an empty / omitted keepPatterns as "everything droppable"', () => {
        const state: ProfileAuthState = {
          cookies: [],
          origins: [
            makeOrigin('https://huge.example', 5_000),
            makeOrigin('https://small.example', 100),
          ],
        };
        const a = trimStateToFit(state, 1_000);
        const b = trimStateToFit(state, 1_000, []);
        expect(a.dropped).to.deep.equal(['https://huge.example']);
        expect(b.dropped).to.deep.equal(['https://huge.example']);
        expect(a.protectedFromDrop).to.deep.equal([]);
        expect(b.protectedFromDrop).to.deep.equal([]);
      });

      it('treats unparseable origins as droppable (not protected by keepPatterns)', () => {
        // originMatchesAny returns true for unparseable origins so they
        // default-drop in the exclusion / --only-domain path. The keep
        // path needs the opposite default — an unparseable origin must
        // not silently inflate `protectedFromDrop` and block the trim.
        const state: ProfileAuthState = {
          cookies: [],
          origins: [
            makeOrigin('not-a-valid-url', 5_000),
            makeOrigin('https://kept.example', 200),
          ],
        };
        const result = trimStateToFit(state, 1_000, ['kept.example']);
        expect(result.dropped).to.deep.equal(['not-a-valid-url']);
        expect(result.protectedFromDrop).to.deep.equal([]);
      });

      it('still drops every other heavy origin when one is kept but over-budget', () => {
        // kept origin alone is 3k, budget is 2k → can't fit even with
        // everything else dropped. Other heavies should still be dropped
        // (best-effort), and the user gets `protectedFromDrop` to act on.
        const state: ProfileAuthState = {
          cookies: [],
          origins: [
            makeOrigin('https://kept.example', 3_000),
            makeOrigin('https://other.example', 2_500),
          ],
        };
        const result = trimStateToFit(state, 2_000, ['kept.example']);
        expect(result.dropped).to.deep.equal(['https://other.example']);
        expect(result.protectedFromDrop).to.deep.equal(['https://kept.example']);
        // Still over budget — caller will surface the protected list.
        expect(result.finalBytes).to.be.greaterThan(2_000);
      });
    });

    it('keeps cookies intact (cookies are not droppable origin-by-origin)', () => {
      const cookie = {
        name: 'session',
        value: 'xyz',
        domain: 'example.com',
        path: '/',
        expires: -1,
        size: 0,
        httpOnly: false,
        secure: true,
        session: true,
      };
      const state: ProfileAuthState = {
        cookies: [cookie],
        origins: [makeOrigin('https://huge.example', 10_000)],
      };
      const result = trimStateToFit(state, 200);
      expect(result.state.cookies).to.deep.equal([cookie]);
      expect(result.state.origins).to.have.length(0);
    });
  });

  describe('formatBytes', () => {
    it('formats sub-KB as B', () => {
      expect(formatBytes(0)).to.equal('0 B');
      expect(formatBytes(512)).to.equal('512 B');
    });

    it('formats KB-range with one decimal', () => {
      expect(formatBytes(1024)).to.equal('1.0 KB');
      expect(formatBytes(2_500)).to.equal('2.4 KB');
    });

    it('formats MB-range with two decimals', () => {
      expect(formatBytes(2 * 1024 * 1024)).to.equal('2.00 MB');
      expect(formatBytes(14_148_253)).to.equal('13.49 MB');
    });
  });
});
