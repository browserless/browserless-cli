import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkProfileLock } from './lock.js';

describe('browsers/lock.checkProfileLock', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserless-cli-lock-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns locked: false when SingletonLock is missing', async () => {
    expect(await checkProfileLock(tempDir)).to.deep.equal({ locked: false });
  });

  it('returns locked: true for a symlink targeting our own (alive) PID', async () => {
    if (process.platform === 'win32') return;
    const target = `testhost-${process.pid}`;
    await fs.symlink(target, path.join(tempDir, 'SingletonLock'));
    const result = await checkProfileLock(tempDir);
    expect(result.locked).to.be.true;
    expect(result.pid).to.equal(process.pid);
    expect(result.hostname).to.equal('testhost');
  });

  it('returns locked: false for a stale symlink with a dead PID', async () => {
    if (process.platform === 'win32') return;
    // 0x7fff_ffff is way past any reasonable live PID.
    const deadPid = 2_147_483_647;
    await fs.symlink(`testhost-${deadPid}`, path.join(tempDir, 'SingletonLock'));
    const result = await checkProfileLock(tempDir);
    expect(result.locked).to.be.false;
    expect(result.pid).to.equal(deadPid);
  });

  it('returns locked: false for a malformed lock target', async () => {
    if (process.platform === 'win32') return;
    await fs.symlink('not-a-valid-target', path.join(tempDir, 'SingletonLock'));
    const result = await checkProfileLock(tempDir);
    expect(result.locked).to.be.false;
  });

  it('returns locked: true when Windows `lockfile` exists (empty marker)', async () => {
    if (process.platform !== 'win32') return;
    // Chrome on Windows writes an empty `lockfile` marker; the real lock
    // is a named mutex we can't observe. Presence = locked, no PID info.
    await fs.writeFile(path.join(tempDir, 'lockfile'), '');
    const result = await checkProfileLock(tempDir);
    expect(result.locked).to.be.true;
    expect(result.pid).to.be.undefined;
  });
});
