import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { onInterrupt } from './interrupt.js';

/** Lets the cleanup → exit chain settle after a synthetic signal. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('utils/interrupt.onInterrupt', () => {
  const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;

  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGBREAK', 130],
  ] as const) {
    it(`runs the cleanup, then exits ${code} on ${signal}`, async () => {
      const target = new EventEmitter();
      const calls: string[] = [];
      onInterrupt(
        async () => {
          calls.push('cleanup');
        },
        { target, exit: (exitCode) => calls.push(`exit ${exitCode}`) },
      );

      target.emit(signal);
      await settle();

      expect(calls).to.deep.equal(['cleanup', `exit ${code}`]);
    });
  }

  it('runs the cleanup once when a second signal arrives mid-cleanup', async () => {
    const target = new EventEmitter();
    let cleanups = 0;
    let finish: () => void = () => undefined;
    const exits: number[] = [];
    onInterrupt(
      () => {
        cleanups += 1;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      { target, exit: (exitCode) => exits.push(exitCode) },
    );

    target.emit('SIGINT');
    target.emit('SIGTERM');
    await settle();
    expect(exits, 'nobody exits before the cleanup finishes').to.deep.equal([]);

    finish();
    await settle();

    expect(cleanups).to.equal(1);
    expect(exits[0]).to.equal(130);
  });

  it('still exits when the cleanup rejects', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    onInterrupt(
      async () => {
        throw new Error('rm failed');
      },
      { target, exit: (exitCode) => exits.push(exitCode) },
    );

    target.emit('SIGTERM');
    await settle();

    expect(exits).to.deep.equal([143]);
  });

  it('removes every handler when disposed', () => {
    const target = new EventEmitter();
    const dispose = onInterrupt(async () => undefined, {
      target,
      exit: () => undefined,
    });
    expect(signals.map((s) => target.listenerCount(s))).to.deep.equal([
      1, 1, 1,
    ]);

    dispose();

    expect(signals.map((s) => target.listenerCount(s))).to.deep.equal([
      0, 0, 0,
    ]);
  });
});
