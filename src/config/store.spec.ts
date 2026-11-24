import { expect } from 'chai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupTempHome, TempHome } from '../test-helpers/temp-home.js';
import { expectRejects } from '../test-helpers/assertions.js';
import { PreconditionError } from '../errors.js';

describe('config/store', () => {
  let home: TempHome;

  beforeEach(async () => {
    home = await setupTempHome();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  it('returns {} when the file is missing', async () => {
    const { readConfig } = await import('./store.js');
    expect(await readConfig()).to.deep.equal({});
  });

  it('round-trips through writeConfig + readConfig', async () => {
    const { readConfig, writeConfig } = await import('./store.js');
    await writeConfig({ server: 'https://example.com', terms_ttl_days: 14 });
    expect(await readConfig()).to.deep.equal({
      server: 'https://example.com',
      terms_ttl_days: 14,
    });
  });

  it('writes config.json with mode 0600', async () => {
    if (process.platform === 'win32') return; // POSIX-only check
    const { writeConfig } = await import('./store.js');
    await writeConfig({ server: 'https://example.com' });
    const stat = await fs.stat(path.join(home.path, '.browserless', 'config.json'));
    expect((stat.mode & 0o777).toString(8)).to.equal('600');
  });

  it('updateConfig reads, patches, and writes', async () => {
    const { readConfig, updateConfig, writeConfig } = await import(
      './store.js'
    );
    await writeConfig({ server: 'https://a.com' });
    await updateConfig((c) => {
      c.terms_ttl_days = 14;
    });
    expect(await readConfig()).to.deep.equal({
      server: 'https://a.com',
      terms_ttl_days: 14,
    });
  });

  it('returns {} for an empty config.json file', async () => {
    await home.writeRawConfig('config.json', '');
    const { readConfig } = await import('./store.js');
    expect(await readConfig()).to.deep.equal({});
  });

  it('throws when config.json contains corrupt JSON', async () => {
    // Returning {} here would let the next updateConfig silently overwrite
    // the user's file. Make the failure visible so they can rescue it.
    await home.writeRawConfig('config.json', '{not actually json');
    const { readConfig } = await import('./store.js');
    const err = await expectRejects(
      () => readConfig(),
      PreconditionError,
      /not valid JSON/,
    );
    expect(err.message).to.match(/config\.json/);
  });

  // Asymmetric on purpose: corrupt JSON throws (above) because returning
  // `{}` would let the next updateConfig overwrite the user's data, but
  // a parsed-to-non-object payload (array / null) is treated as first-run
  // empty shape because the user can recover by writing into it. See the
  // readConfig docstring for the full rationale.
  it('returns {} when the file parses to a non-object (array, null, etc.)', async () => {
    await home.writeRawConfig('config.json', '[1, 2, 3]');
    const { readConfig } = await import('./store.js');
    expect(await readConfig()).to.deep.equal({});
  });
});
