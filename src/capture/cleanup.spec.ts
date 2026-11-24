import { expect } from 'chai';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createCaptureCleanup } from './cleanup.js';

const exists = (dir: string) =>
  fs.stat(dir).then(
    () => true,
    () => false,
  );

describe('capture/cleanup.createCaptureCleanup', () => {
  let dir: string;
  const child = { pid: 4242 } as ChildProcess;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-spec-'));
    await fs.writeFile(path.join(dir, 'Cookies'), 'x');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('waits for a launch still in flight and stops its browser before deleting the copy', async () => {
    let resolveLaunch: (value: { child: ChildProcess }) => void = () =>
      undefined;
    const launching = new Promise<{ child: ChildProcess }>((resolve) => {
      resolveLaunch = resolve;
    });
    const killed: { child: ChildProcess; dirExisted: boolean }[] = [];
    const cleanup = createCaptureCleanup(
      () => dir,
      () => launching,
      async (c) => {
        killed.push({ child: c, dirExisted: await exists(dir) });
      },
    );

    const done = cleanup();
    await new Promise((resolve) => setImmediate(resolve));
    expect(killed, 'nothing to kill until the launch settles').to.deep.equal(
      [],
    );
    expect(await exists(dir), 'copy kept while the launch is pending').to.equal(
      true,
    );

    resolveLaunch({ child });
    await done;

    expect(killed).to.deep.equal([{ child, dirExisted: true }]);
    expect(await exists(dir)).to.equal(false);
  });

  it('still stops the browser when no temp dir exists yet', async () => {
    const kills: ChildProcess[] = [];
    await createCaptureCleanup(
      () => undefined,
      () => Promise.resolve({ child }),
      async (c) => {
        kills.push(c);
      },
    )();
    expect(kills).to.deep.equal([child]);
  });

  it('aborts an in-flight copy before deleting it', async () => {
    const order: string[] = [];
    await createCaptureCleanup(
      () => dir,
      () => undefined,
      async () => undefined,
      () => order.push(`abort (copy exists: ${existsSync(dir)})`),
    )();
    order.push(`after cleanup (copy exists: ${existsSync(dir)})`);
    expect(order).to.deep.equal([
      'abort (copy exists: true)',
      'after cleanup (copy exists: false)',
    ]);
  });

  it('runs once, however many times it is called', async () => {
    let kills = 0;
    const cleanup = createCaptureCleanup(
      () => dir,
      () => Promise.resolve({ child }),
      async () => {
        kills += 1;
      },
    );

    const first = cleanup();
    const second = cleanup();
    await Promise.all([first, second]);

    expect(second).to.equal(first);
    expect(kills).to.equal(1);
  });

  it('still deletes the copy when the launch failed or never started', async () => {
    const kills: ChildProcess[] = [];
    const kill = async (c: ChildProcess) => {
      kills.push(c);
    };

    await createCaptureCleanup(
      () => dir,
      () => Promise.reject(new Error('spawn ENOENT')),
      kill,
    )();
    expect(await exists(dir)).to.equal(false);

    await fs.mkdir(dir);
    await createCaptureCleanup(
      () => dir,
      () => undefined,
      kill,
    )();
    expect(await exists(dir)).to.equal(false);
    expect(kills).to.deep.equal([]);
  });
});
