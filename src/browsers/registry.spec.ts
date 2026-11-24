import { expect } from 'chai';
import {
  BUILT_IN_BROWSERS,
  findBuiltInByKeyOrName,
} from './registry.js';

describe('browsers/registry', () => {
  it('declares a unique key for every built-in', () => {
    const keys = BUILT_IN_BROWSERS.map((b) => b.key);
    expect(new Set(keys).size).to.equal(keys.length);
  });

  it('declares a unique display name for every built-in', () => {
    const names = BUILT_IN_BROWSERS.map((b) => b.displayName);
    expect(new Set(names).size).to.equal(names.length);
  });

  it('matches by short key (case-insensitive)', () => {
    const hit = findBuiltInByKeyOrName('CHROME');
    expect(hit?.key).to.equal('chrome');
  });

  it('matches by display name (case-insensitive)', () => {
    const hit = findBuiltInByKeyOrName('google chrome');
    expect(hit?.key).to.equal('chrome');
  });

  it('returns null for unknown input', () => {
    expect(findBuiltInByKeyOrName('does-not-exist')).to.be.null;
  });

  it('declares chrome, brave, edge as v1 plan requires', () => {
    expect(findBuiltInByKeyOrName('chrome')).to.not.be.null;
    expect(findBuiltInByKeyOrName('brave')).to.not.be.null;
    expect(findBuiltInByKeyOrName('edge')).to.not.be.null;
  });

  it('declares chromium (the upstream OSS build) for arch / nixos / privacy distros', () => {
    const hit = findBuiltInByKeyOrName('chromium');
    expect(hit).to.not.be.null;
    expect(hit?.userDataDirByPlatform.darwin).to.be.a('string');
    expect(hit?.userDataDirByPlatform.win32).to.be.a('string');
    // Linux is a tuple: apt-style user-data-dir + Snap-confined dir.
    // path.join uses the host separator regardless of the target platform
    // (the registry is built at module-load time), so the regex below
    // accepts both `/` and `\` between segments.
    const linuxDirs = hit?.userDataDirByPlatform.linux;
    expect(Array.isArray(linuxDirs)).to.be.true;
    expect((linuxDirs as string[]).some((p) => /[\\/]\.config[\\/]chromium$/.test(p))).to.be.true;
    expect((linuxDirs as string[]).some((p) => /[\\/]snap[\\/]chromium[\\/]common[\\/]chromium$/.test(p))).to.be.true;
    expect(hit?.binaryPathByPlatform.linux).to.include('/snap/bin/chromium');
  });
});
