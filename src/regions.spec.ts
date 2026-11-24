import { expect } from 'chai';
import {
  isKnownRegion,
  KNOWN_REGIONS,
  REGION_URLS,
  regionToServerUrl,
} from './regions.js';
import { UsageError } from './errors.js';
import { expectRejects } from './test-helpers/assertions.js';

describe('regions', () => {
  it('declares sfo, lon, ams as the known production regions', () => {
    expect(KNOWN_REGIONS).to.have.members(['sfo', 'lon', 'ams']);
  });

  it('each known region maps to its production-<code>.browserless.io URL', () => {
    for (const code of KNOWN_REGIONS) {
      expect(REGION_URLS[code]).to.equal(
        `https://production-${code}.browserless.io`,
      );
    }
  });

  it('isKnownRegion is case-sensitive', () => {
    expect(isKnownRegion('sfo')).to.equal(true);
    expect(isKnownRegion('SFO')).to.equal(false);
    expect(isKnownRegion('not-a-region')).to.equal(false);
  });

  it('regionToServerUrl returns the URL for valid codes', () => {
    expect(regionToServerUrl('lon')).to.equal(
      'https://production-lon.browserless.io',
    );
  });

  it('regionToServerUrl throws UsageError listing known codes', async () => {
    const err = await expectRejects(
      async () => regionToServerUrl('zzz'),
      UsageError,
      /Known regions:/,
    );
    expect(err.message).to.match(/sfo/);
    expect(err.code).to.equal('unknown-region');
  });
});
