import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectLinuxPasswordStore,
  isValidPasswordStore,
  resolveLinuxPasswordStore,
} from './password-store.js';

describe('browsers/password-store', () => {
  describe('isValidPasswordStore', () => {
    it('accepts known stores', () => {
      expect(isValidPasswordStore('basic')).to.be.true;
      expect(isValidPasswordStore('gnome-libsecret')).to.be.true;
      expect(isValidPasswordStore('kwallet5')).to.be.true;
      expect(isValidPasswordStore('detect')).to.be.true;
    });
    it('rejects unknown stores', () => {
      expect(isValidPasswordStore('keychain')).to.be.false;
      expect(isValidPasswordStore('')).to.be.false;
    });
  });

  describe('detectLinuxPasswordStore', () => {
    it('returns null on non-Linux platforms', async () => {
      if (process.platform === 'linux') return;
      expect(await detectLinuxPasswordStore('/tmp')).to.be.null;
    });
  });

  describe('resolveLinuxPasswordStore', () => {
    let tempUserDataDir: string;
    beforeEach(async () => {
      tempUserDataDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'browserless-cli-pws-'),
      );
    });
    afterEach(async () => {
      await fs.rm(tempUserDataDir, { recursive: true, force: true });
    });

    it('respects an override', async () => {
      const result = await resolveLinuxPasswordStore(
        tempUserDataDir,
        'gnome-libsecret',
      );
      expect(result).to.deep.equal({
        store: 'gnome-libsecret',
        defaulted: false,
      });
    });

    it('ignores invalid overrides and continues to detection', async () => {
      const result = await resolveLinuxPasswordStore(
        tempUserDataDir,
        'not-a-real-store',
      );
      // On non-Linux this defaults to basic; same on Linux without prefs
      expect(result.store).to.equal('basic');
      expect(result.defaulted).to.be.true;
    });

    it('defaults to basic with defaulted=true on non-Linux', async () => {
      if (process.platform === 'linux') return;
      const result = await resolveLinuxPasswordStore(tempUserDataDir);
      expect(result).to.deep.equal({ store: 'basic', defaulted: true });
    });
  });
});
