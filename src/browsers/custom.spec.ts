import { expect } from 'chai';
import {
  addCustomBrowser,
  readCustomBrowsers,
  removeCustomBrowser,
} from './custom.js';
import { setupTempHome, TempHome } from '../test-helpers/temp-home.js';
import { expectRejects } from '../test-helpers/assertions.js';
import { PreconditionError, UsageError } from '../errors.js';
import fs from 'node:fs/promises';
import { customBrowsersFile } from '../config/paths.js';

describe('browsers/custom', () => {
  let home: TempHome;
  beforeEach(async () => {
    home = await setupTempHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('returns [] when the file is missing', async () => {
    expect(await readCustomBrowsers()).to.deep.equal([]);
  });

  it('round-trips through addCustomBrowser + readCustomBrowsers (first run, no pre-created dir)', async () => {
    // addCustomBrowser must mkdir ~/.browserless/ itself — a first-run
    // user has not invoked any other config-writing command yet.
    await addCustomBrowser({
      name: 'my-chromium',
      binaryPath: '/path/to/bin',
      userDataDir: '/path/to/data',
    });
    const list = await readCustomBrowsers();
    expect(list).to.have.length(1);
    expect(list[0].name).to.equal('my-chromium');
  });

  it('rejects duplicate names case-insensitively', async () => {
    await addCustomBrowser({
      name: 'my-chromium',
      binaryPath: '/p',
      userDataDir: '/d',
    });
    let threw = false;
    try {
      await addCustomBrowser({
        name: 'MY-CHROMIUM',
        binaryPath: '/p2',
        userDataDir: '/d2',
      });
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(UsageError);
    }
    expect(threw).to.be.true;
  });

  it('removeCustomBrowser returns true on success', async () => {
    await addCustomBrowser({
      name: 'my-chromium',
      binaryPath: '/p',
      userDataDir: '/d',
    });
    expect(await removeCustomBrowser('my-chromium')).to.be.true;
    expect(await readCustomBrowsers()).to.deep.equal([]);
  });

  it('removeCustomBrowser returns false on miss', async () => {
    expect(await removeCustomBrowser('does-not-exist')).to.be.false;
  });

  it('writes the file with mode 0600', async () => {
    if (process.platform === 'win32') return;
    await addCustomBrowser({
      name: 'a',
      binaryPath: '/p',
      userDataDir: '/d',
    });
    const stat = await fs.stat(customBrowsersFile());
    expect((stat.mode & 0o777).toString(8)).to.equal('600');
  });

  describe('corrupt-file handling', () => {
    beforeEach(async () => {
      await home.ensureConfigDir();
    });

    it('throws PreconditionError on invalid JSON (must not silently wipe the file)', async () => {
      await home.writeRawConfig('custom-browsers.json', '{ not valid');
      await expectRejects(
        () => readCustomBrowsers(),
        PreconditionError,
        /not valid JSON/,
      );
    });

    it('throws PreconditionError with array-specific message when payload is not an array', async () => {
      // The "not an array" branch should point at array-ness, not entry
      // shape — the user passed an object, telling them about
      // { name, binaryPath, userDataDir } would be misleading.
      await home.writeRawConfig(
        'custom-browsers.json',
        JSON.stringify({ foo: 'bar' }),
      );
      const err = await expectRejects(
        () => readCustomBrowsers(),
        PreconditionError,
        /a JSON array/,
      );
      expect(err.message).to.not.match(/binaryPath/);
    });

    it('throws PreconditionError with shape-specific message when entries are missing required fields', async () => {
      // The "bad-entry-shape" branch should name the required fields.
      await home.writeRawConfig(
        'custom-browsers.json',
        JSON.stringify([{ name: 'foo' }]),
      );
      await expectRejects(
        () => readCustomBrowsers(),
        PreconditionError,
        /\{ name, binaryPath, userDataDir \}/,
      );
    });

    it('returns [] when the file is empty (treat as first-run)', async () => {
      await home.writeRawConfig('custom-browsers.json', '');
      expect(await readCustomBrowsers()).to.deep.equal([]);
    });
  });
});
