import { expect } from 'chai';
import {
  applyExclusions,
  applyOnlyFilter,
  mergeExclusionPatterns,
  normalizeExclusion,
  originAllowedBy,
} from './exclusion.js';
import {
  ProfileAuthState,
  ProfileCookie,
} from './types.js';

const cookie = (overrides: Partial<ProfileCookie>): ProfileCookie => ({
  name: 'k',
  value: 'v',
  domain: 'example.com',
  path: '/',
  expires: -1,
  size: 0,
  httpOnly: false,
  secure: false,
  session: false,
  ...overrides,
});

describe('capture/exclusion', () => {
  describe('normalizeExclusion', () => {
    it('strips a leading dot', () => {
      expect(normalizeExclusion('.example.com')).to.equal('example.com');
    });
    it('strips a wildcard prefix', () => {
      expect(normalizeExclusion('*.example.com')).to.equal('example.com');
    });
    it('lowercases', () => {
      expect(normalizeExclusion('Example.COM')).to.equal('example.com');
    });
    it('extracts hostname from a URL', () => {
      expect(normalizeExclusion('https://Example.com/foo')).to.equal(
        'example.com',
      );
    });
    it('returns null for empty input', () => {
      expect(normalizeExclusion('   ')).to.be.null;
    });
    // Cookie domains come back from CDP in punycode (the on-the-wire form).
    // If a user types a non-ASCII pattern, we normalize it to the same form
    // so the match works in both directions.
    it('punycode-normalizes a non-ASCII bare hostname', () => {
      expect(normalizeExclusion('münchen.de')).to.equal('xn--mnchen-3ya.de');
    });
    it('punycode-normalizes a non-ASCII URL', () => {
      expect(normalizeExclusion('https://münchen.de/path')).to.equal(
        'xn--mnchen-3ya.de',
      );
    });
  });

  describe('applyExclusions', () => {
    const baseState: ProfileAuthState = {
      cookies: [
        cookie({ domain: 'example.com' }),
        cookie({ domain: '.example.com', name: 'k2' }),
        cookie({ domain: 'sub.example.com', name: 'k3' }),
        cookie({ domain: 'other.com', name: 'k4' }),
        cookie({ domain: 'examplenotmatch.com', name: 'k5' }),
      ],
      origins: [
        { origin: 'https://example.com', localStorage: { a: 'b' } },
        { origin: 'https://app.example.com', localStorage: { a: 'b' } },
        { origin: 'https://other.com', localStorage: { a: 'b' } },
      ],
    };

    it('matches by suffix on cookies and origins', () => {
      const result = applyExclusions(baseState, ['example.com']);
      expect(result.cookiesDropped).to.equal(3);
      expect(result.originsDropped).to.equal(2);
      expect(result.state.cookies.map((c) => c.name)).to.deep.equal([
        'k4',
        'k5',
      ]);
      expect(result.state.origins).to.have.length(1);
      expect(result.state.origins[0].origin).to.equal('https://other.com');
    });

    it('returns input unchanged when no patterns', () => {
      const result = applyExclusions(baseState, []);
      expect(result.cookiesDropped).to.equal(0);
      expect(result.originsDropped).to.equal(0);
      expect(result.state).to.equal(baseState);
    });

    it('treats *.foo.com as foo.com', () => {
      const result = applyExclusions(baseState, ['*.example.com']);
      expect(result.cookiesDropped).to.equal(3);
    });

    it('does not match unrelated suffixes', () => {
      const result = applyExclusions(baseState, ['notmatch.com']);
      expect(result.cookiesDropped).to.equal(0);
      expect(result.originsDropped).to.equal(0);
    });

    it('excludes punycode cookie domains via a Unicode pattern', () => {
      // Chrome stores `cookie.domain` in punycode (`xn--...`). A user who
      // types the Unicode form into the exclusion list should still see
      // the cookie dropped.
      const state: ProfileAuthState = {
        cookies: [
          cookie({ domain: 'xn--mnchen-3ya.de', name: 'idn-cookie' }),
          cookie({ domain: 'example.com', name: 'keep' }),
        ],
        origins: [
          { origin: 'https://xn--mnchen-3ya.de', localStorage: { a: 'b' } },
          { origin: 'https://example.com', localStorage: { a: 'b' } },
        ],
      };
      const result = applyExclusions(state, ['münchen.de']);
      expect(result.cookiesDropped).to.equal(1);
      expect(result.originsDropped).to.equal(1);
      expect(result.state.cookies.map((c) => c.name)).to.deep.equal(['keep']);
    });

    it('drops origins that fail to parse defensively', () => {
      const malformed: ProfileAuthState = {
        cookies: [],
        origins: [{ origin: 'not-a-url', localStorage: {} }],
      };
      const result = applyExclusions(malformed, ['anything.com']);
      expect(result.state.origins).to.be.empty;
    });

    it('drops cookies whose domain has a leading dot', () => {
      const state: ProfileAuthState = {
        cookies: [
          cookie({ domain: '.example.com' }),
          cookie({ domain: 'sub.example.com', name: 'sub' }),
          cookie({ domain: 'unrelated.com', name: 'keep' }),
        ],
        origins: [],
      };
      const result = applyExclusions(state, ['example.com']);
      expect(result.cookiesDropped).to.equal(2);
      expect(result.state.cookies.map((c) => c.name)).to.deep.equal(['keep']);
    });

    it('drops origins with explicit port numbers', () => {
      const state: ProfileAuthState = {
        cookies: [],
        origins: [
          { origin: 'https://example.com:8080', localStorage: {} },
          { origin: 'https://api.example.com:8443', localStorage: {} },
          { origin: 'https://other.com:9000', localStorage: {} },
        ],
      };
      const result = applyExclusions(state, ['example.com']);
      expect(result.originsDropped).to.equal(2);
      expect(result.state.origins.map((o) => o.origin)).to.deep.equal([
        'https://other.com:9000',
      ]);
    });
  });

  describe('applyOnlyFilter', () => {
    it('is a no-op when patterns is empty', () => {
      const state: ProfileAuthState = {
        cookies: [cookie({ domain: '.example.com' })],
        origins: [
          { origin: 'https://example.com', localStorage: { k: 'v' } },
        ],
      };
      const result = applyOnlyFilter(state, []);
      expect(result.state).to.equal(state);
      expect(result.cookiesDropped).to.equal(0);
      expect(result.originsDropped).to.equal(0);
    });

    it('keeps only origins whose hostname suffix-matches a pattern', () => {
      const state: ProfileAuthState = {
        cookies: [],
        origins: [
          { origin: 'https://mail.google.com', localStorage: { k: 'v' } },
          { origin: 'https://accounts.google.com', localStorage: { k: 'v' } },
          { origin: 'https://kucoin.com', localStorage: { k: 'v' } },
          { origin: 'https://example.com', localStorage: { k: 'v' } },
        ],
      };
      const result = applyOnlyFilter(state, ['google.com', 'kucoin.com']);
      expect(result.state.origins.map((o) => o.origin).sort()).to.deep.equal([
        'https://accounts.google.com',
        'https://kucoin.com',
        'https://mail.google.com',
      ]);
      expect(result.originsDropped).to.equal(1);
    });

    it('keeps only cookies whose domain suffix-matches a pattern', () => {
      // Cookie `.google.com` applies to every subdomain of google.com — it
      // should be kept when the user asks for `--only-domain google.com`
      // (or `mail.google.com`, since the cookie also applies there).
      const state: ProfileAuthState = {
        cookies: [
          cookie({ name: 'gauth', domain: '.google.com' }),
          cookie({ name: 'mail', domain: 'mail.google.com' }),
          cookie({ name: 'other', domain: '.kucoin.com' }),
          cookie({ name: 'misc', domain: '.example.com' }),
        ],
        origins: [],
      };
      const result = applyOnlyFilter(state, ['google.com']);
      expect(result.state.cookies.map((c) => c.name).sort()).to.deep.equal([
        'gauth',
        'mail',
      ]);
      expect(result.cookiesDropped).to.equal(2);
    });

    it('drops unparseable origins (cannot match an allowlist defensively)', () => {
      const state: ProfileAuthState = {
        cookies: [],
        origins: [
          { origin: 'https://example.com', localStorage: { k: 'v' } },
          { origin: 'not a url', localStorage: { k: 'v' } },
        ],
      };
      const result = applyOnlyFilter(state, ['example.com']);
      expect(result.state.origins.map((o) => o.origin)).to.deep.equal([
        'https://example.com',
      ]);
      expect(result.originsDropped).to.equal(1);
    });

    it('normalizes user-supplied patterns the same way --exclude-domain does', () => {
      // `*.example.com`, `.example.com`, `EXAMPLE.com`, and a full URL
      // all resolve to `example.com` via normalizeExclusion. Mixing them
      // shouldn't matter.
      const state: ProfileAuthState = {
        cookies: [],
        origins: [
          { origin: 'https://example.com', localStorage: { k: 'v' } },
          { origin: 'https://other.example', localStorage: { k: 'v' } },
        ],
      };
      const variants = [
        '*.example.com',
        '.example.com',
        'EXAMPLE.com',
        'https://example.com/foo',
      ];
      for (const v of variants) {
        const result = applyOnlyFilter(state, [v]);
        expect(result.state.origins.map((o) => o.origin)).to.deep.equal([
          'https://example.com',
        ]);
      }
    });
  });

  describe('originAllowedBy', () => {
    it('returns true for an exact suffix-match', () => {
      expect(originAllowedBy('https://imdb.com', ['imdb.com'])).to.be.true;
      expect(originAllowedBy('https://www.imdb.com', ['imdb.com'])).to.be.true;
    });
    it('returns false when no pattern matches', () => {
      expect(originAllowedBy('https://other.example', ['imdb.com'])).to.be
        .false;
    });
    it('returns false for an unparseable origin (allowlist semantics)', () => {
      // `originMatchesAny` returns true for unparseable origins (drop-by-
      // default for exclusion). The allowlist counterpart must invert:
      // unparseable → false, so an origin we can't read doesn't sneak past
      // a --only-domain filter.
      expect(originAllowedBy('not-a-url', ['imdb.com'])).to.be.false;
    });
    it('returns false when patterns is empty', () => {
      expect(originAllowedBy('https://imdb.com', [])).to.be.false;
    });
  });

  describe('mergeExclusionPatterns', () => {
    it('concatenates config + flag when noDefault is false', () => {
      expect(mergeExclusionPatterns(['a.com'], ['b.com'], false)).to.deep.equal(
        ['a.com', 'b.com'],
      );
    });
    it('uses only flag when noDefault is true', () => {
      expect(mergeExclusionPatterns(['a.com'], ['b.com'], true)).to.deep.equal(
        ['b.com'],
      );
    });
    it('handles undefined input', () => {
      expect(mergeExclusionPatterns(undefined, undefined, false)).to.deep.equal(
        [],
      );
    });
  });
});
