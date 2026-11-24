import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sinon from 'sinon';
import { writeSecureJsonFile } from './json-file.js';

describe('utils/json-file.writeSecureJsonFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserless-cli-jsonfile-'));
  });

  afterEach(async () => {
    sinon.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('atomic: true', () => {
    // The atomic path is the contract that protects against half-written
    // config.json on a crash mid-write. Pinning the temp-rename here so
    // a future refactor can't silently drop the atomicity by collapsing
    // to a direct `fs.writeFile`.
    it('writes to a temp file and renames it over the target', async () => {
      const renameSpy = sinon.spy(fs, 'rename');
      const writeFileSpy = sinon.spy(fs, 'writeFile');
      const target = path.join(tempDir, 'config.json');

      await writeSecureJsonFile(target, { foo: 1 }, { atomic: true });

      // writeFile should land on a temp path, not on the target.
      const writeArgs = writeFileSpy.firstCall.args[0] as string;
      expect(writeArgs).to.not.equal(target);
      expect(writeArgs).to.include(`.config.json.${process.pid}.tmp`);

      // rename should move temp → target.
      expect(renameSpy.calledOnce).to.be.true;
      const [from, to] = renameSpy.firstCall.args as [string, string];
      expect(from).to.equal(writeArgs);
      expect(to).to.equal(target);

      // Final file exists with expected content.
      const content = JSON.parse(await fs.readFile(target, 'utf-8'));
      expect(content).to.deep.equal({ foo: 1 });
    });
  });

  describe('atomic: false (default)', () => {
    it('writes directly to the target without a rename', async () => {
      const renameSpy = sinon.spy(fs, 'rename');
      const writeFileSpy = sinon.spy(fs, 'writeFile');
      const target = path.join(tempDir, 'custom-browsers.json');

      await writeSecureJsonFile(target, [{ a: 1 }]);

      expect(renameSpy.notCalled).to.be.true;
      const writeArgs = writeFileSpy.firstCall.args[0] as string;
      expect(writeArgs).to.equal(target);

      const content = JSON.parse(await fs.readFile(target, 'utf-8'));
      expect(content).to.deep.equal([{ a: 1 }]);
    });
  });

  it('mkdirs the parent dir (mode 0700 on POSIX) before writing', async () => {
    const nested = path.join(tempDir, 'a', 'b', 'config.json');
    await writeSecureJsonFile(nested, {}, { atomic: true });
    const stat = await fs.stat(path.dirname(nested));
    expect(stat.isDirectory()).to.be.true;
    if (process.platform !== 'win32') {
      expect((stat.mode & 0o777).toString(8)).to.equal('700');
    }
  });
});
