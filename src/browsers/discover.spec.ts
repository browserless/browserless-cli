import { expect } from 'chai';
import {
  DetectedProfile,
  resolveProfileFromCandidates,
  whichOnPath,
} from './discover.js';
import { UsageError } from '../errors.js';

describe('browsers/discover.whichOnPath', () => {
  it('returns the absolute path for a command on PATH', async () => {
    if (process.platform === 'win32') {
      // Skip on Windows — `which` isn't a built-in (`where` is the
      // equivalent), and the Linux fallback in `firstExisting` is gated
      // behind `process.platform === 'linux'` anyway.
      return;
    }
    // `ls` is essentially guaranteed on macOS + Linux.
    const found = await whichOnPath('ls');
    expect(found).to.be.a('string');
    expect(found).to.match(/[\\/]ls$/);
  });

  it('returns null for a command that does not exist on PATH', async () => {
    if (process.platform === 'win32') return;
    const found = await whichOnPath(
      'definitely-not-a-real-binary-xyz-' + process.pid,
    );
    expect(found).to.be.null;
  });

  it('returns null when which itself errors out', async () => {
    if (process.platform === 'win32') return;
    // Empty command name: `which ''` exits non-zero with no stdout.
    const found = await whichOnPath('');
    expect(found).to.be.null;
  });
});

describe('browsers/discover.resolveProfileFromCandidates', () => {
  const REGISTRY = [
    { key: 'chrome', displayName: 'Google Chrome' },
    { key: 'brave', displayName: 'Brave' },
  ];

  const profile = (
    browserKey: string,
    profileDirName: string,
    profileDisplayName: string,
  ): DetectedProfile => ({
    browserKey,
    browserDisplayName: REGISTRY.find((b) => b.key === browserKey)!.displayName,
    profileDirName,
    profileDisplayName,
    userDataDir: `/fake/${browserKey}`,
    profilePath: `/fake/${browserKey}/${profileDirName}`,
    binaryPath: `/fake/bin/${browserKey}`,
  });

  it('escapes selectors and candidate fields without flattening guidance', () => {
    const browser = 'chrome\nforged-browser';
    const name = 'work\nforged-profile';
    const registry = [{ key: browser, displayName: browser }];
    const detected = ['Default\nforged-dir', 'Profile 1'].map((dir) => ({
      ...profile('chrome', dir, name),
      browserKey: browser,
      browserDisplayName: browser,
    }));
    for (const [input, candidates, lines] of [
      ['missing', detected, 3],
      [name, detected, 3],
      [name, [], 1],
    ] as const) {
      try {
        resolveProfileFromCandidates(browser, input, registry, [...candidates]);
        expect.fail('expected a usage error');
      } catch (err) {
        expect(err).to.be.instanceOf(UsageError);
        const message = (err as Error).message;
        expect(message.split('\n')).to.have.length(lines);
        expect(message).to.include('chrome\\u000aforged-browser');
        if (candidates.length) {
          expect(message).to.include('work\\u000aforged-profile');
          expect(message).to.include('Default\\u000aforged-dir');
        }
      }
    }
    expect(() => resolveProfileFromCandidates(browser, name, [], [])).to.throw(
      'Unknown browser "chrome\\u000aforged-browser"',
    );
  });

  it('returns the single matching profile when input is unambiguous', () => {
    const detected = [profile('chrome', 'Default', 'Personal')];
    const got = resolveProfileFromCandidates(
      'chrome',
      'Default',
      REGISTRY,
      detected,
    );
    expect(got.browserKey).to.equal('chrome');
    expect(got.profileDirName).to.equal('Default');
  });

  it('accepts the display name in place of the registry key', () => {
    const detected = [profile('chrome', 'Default', 'Personal')];
    const got = resolveProfileFromCandidates(
      'Google Chrome',
      'Personal',
      REGISTRY,
      detected,
    );
    expect(got.browserKey).to.equal('chrome');
  });

  it('matches case-insensitively across browser + profile inputs', () => {
    const detected = [profile('chrome', 'Default', 'Personal')];
    const got = resolveProfileFromCandidates(
      'CHROME',
      'PERSONAL',
      REGISTRY,
      detected,
    );
    expect(got.browserKey).to.equal('chrome');
  });

  it('rejects unknown browsers with the registry-list hint', () => {
    let threw = false;
    try {
      resolveProfileFromCandidates('safari', 'Default', REGISTRY, []);
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(UsageError);
      expect((err as UsageError).code).to.equal('unknown-browser');
      expect((err as Error).message).to.match(/Unknown browser "safari"/);
      expect((err as Error).message).to.match(/profile sources list/);
    }
    expect(threw).to.be.true;
  });

  it('reports zero detected profiles for a known but uninstalled browser', () => {
    let threw = false;
    try {
      resolveProfileFromCandidates('brave', 'Default', REGISTRY, []);
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(UsageError);
      expect((err as Error).message).to.match(
        /Browser "brave" is registered but has no detected profiles/,
      );
      expect((err as UsageError).code).to.equal('browser-has-no-profiles');
    }
    expect(threw).to.be.true;
  });

  it('lists same-browser profiles when the profile name does not match', () => {
    const detected = [
      profile('chrome', 'Default', 'Personal'),
      profile('chrome', 'Profile 1', 'Work'),
    ];
    let threw = false;
    try {
      resolveProfileFromCandidates(
        'chrome',
        'NoSuchProfile',
        REGISTRY,
        detected,
      );
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(UsageError);
      const msg = (err as Error).message;
      expect(msg).to.match(/No profile named "NoSuchProfile" under chrome/);
      expect((err as UsageError).code).to.equal('local-profile-not-found');
      // Both candidates must be enumerated, with display name + dir name
      // so the user can copy-paste either form to disambiguate.
      expect(msg).to.match(/Personal \(Default\)/);
      expect(msg).to.match(/Work \(Profile 1\)/);
    }
    expect(threw).to.be.true;
  });

  it('lists ambiguous candidates when multiple profiles match', () => {
    // Same display name under two different on-disk dirs — the user
    // should be told to disambiguate via the directory name.
    const detected = [
      profile('chrome', 'Default', 'Personal'),
      profile('chrome', 'Profile 1', 'Personal'),
    ];
    let threw = false;
    try {
      resolveProfileFromCandidates('chrome', 'Personal', REGISTRY, detected);
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(UsageError);
      const msg = (err as Error).message;
      expect(msg).to.match(/matches multiple entries/);
      expect((err as UsageError).code).to.equal('local-profile-ambiguous');
      expect(msg).to.match(/disambiguate.*directory name/);
      expect(msg).to.include('dir: Default');
      expect(msg).to.include('dir: Profile 1');
    }
    expect(threw).to.be.true;
  });
});
