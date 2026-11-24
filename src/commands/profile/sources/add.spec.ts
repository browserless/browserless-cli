import { expect } from 'chai';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { registerSourcesAdd } from './add.js';
import {
  readCustomBrowsers,
  removeCustomBrowser,
} from '../../../browsers/custom.js';
import { resolveProfile } from '../../../browsers/discover.js';
import { PreconditionError } from '../../../errors.js';
import { expectRejects } from '../../../test-helpers/assertions.js';
import { setupTempHome, TempHome } from '../../../test-helpers/temp-home.js';

describe('custom source path safety', () => {
  let home: TempHome;
  let originalCwd: string;
  let registrationDir: string;
  let otherDir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    home = await setupTempHome();
    // process.cwd() resolves aliases such as macOS /var -> /private/var.
    const tempDir = await fs.realpath(home.path);
    registrationDir = path.join(tempDir, 'registration');
    otherDir = path.join(tempDir, 'other');
    for (const dir of [registrationDir, otherDir]) {
      await fs.mkdir(path.join(dir, 'profile data', 'Default'), {
        recursive: true,
      });
      await fs.writeFile(path.join(dir, 'browser'), '');
      await fs.writeFile(
        path.join(dir, 'profile data', 'Default', 'Preferences'),
        '{}',
      );
    }
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await home.cleanup();
  });

  for (const relative of [true, false]) {
    it(`keeps ${relative ? 'relative' : 'absolute'} registrations bound to their original directory`, async () => {
      process.chdir(registrationDir);
      const command = new Command();
      registerSourcesAdd(command);
      await command.parseAsync(
        [
          'add',
          '--name',
          'custom',
          '--path',
          relative ? './browser' : path.join(registrationDir, 'browser'),
          '--user-data-dir',
          relative
            ? './profile data'
            : path.join(registrationDir, 'profile data'),
        ],
        { from: 'user' },
      );
      process.chdir(otherDir);
      const profile = await resolveProfile('custom', 'Default');
      expect(profile.binaryPath).to.equal(
        path.join(registrationDir, 'browser'),
      );
      expect(profile.userDataDir).to.equal(
        path.join(registrationDir, 'profile data'),
      );
      expect(profile.profilePath).to.equal(
        path.join(registrationDir, 'profile data', 'Default'),
      );
      expect(await readCustomBrowsers()).to.deep.equal([
        {
          name: 'custom',
          binaryPath: path.join(registrationDir, 'browser'),
          userDataDir: path.join(registrationDir, 'profile data'),
        },
      ]);
    });
  }

  for (const field of ['binaryPath', 'userDataDir']) {
    it(`requires re-registration of a legacy relative ${field} without preventing removal`, async () => {
      const valid = {
        name: 'valid',
        binaryPath: path.join(registrationDir, 'browser'),
        userDataDir: path.join(registrationDir, 'profile data'),
      };
      const legacy = {
        ...valid,
        name: 'legacy',
        [field]: field === 'binaryPath' ? './browser' : './profile data',
      };
      const raw = JSON.stringify([legacy, valid]);
      await home.writeRawConfig('custom-browsers.json', raw);
      process.chdir(otherDir);
      const error = await expectRejects(
        () => resolveProfile('legacy', 'Default'),
        PreconditionError,
        /re-register/i,
      );
      expect(error.message).to.include('profile sources rm');
      expect(
        await fs.readFile(
          path.join(home.path, '.browserless', 'custom-browsers.json'),
          'utf8',
        ),
      ).to.equal(raw);
      expect(await removeCustomBrowser('legacy')).to.be.true;
      expect(await readCustomBrowsers()).to.deep.equal([valid]);
      expect((await resolveProfile('valid', 'Default')).binaryPath).to.equal(
        valid.binaryPath,
      );
    });
  }
});
