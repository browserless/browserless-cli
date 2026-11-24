import { expect } from 'chai';
import { Command } from 'commander';
import { UsageError } from '../../errors.js';
import { expectRejects } from '../../test-helpers/assertions.js';
import { formatProfileBusyMessage, registerLaunch } from './launch.js';

describe('commands/profile/launch.formatProfileBusyMessage', () => {
  it('rejects empty capture flags with a stable code', async () => {
    const program = new Command().exitOverride();
    registerLaunch(program);
    const err = await expectRejects(
      () =>
        program.parseAsync(['launch', '--browser', '', '--profile', ''], {
          from: 'user',
        }),
      UsageError,
      /--browser and --profile are required/,
    );
    expect(err.code).to.equal('missing-required-flag');
  });

  // The lock-refusal branch has two flavors depending on which lockfile
  // semantics the platform exposes — POSIX surfaces the holder's PID via
  // SingletonLock, Windows has an empty-marker lockfile with no PID
  // attached. The message must read correctly in both shapes.

  it('includes the PID when present (POSIX SingletonLock)', () => {
    const msg = formatProfileBusyMessage('Google Chrome', 12345);
    expect(msg).to.match(/Google Chrome is already running \(PID 12345\)\./);
    expect(msg).to.match(/Quit it first/);
    expect(msg).to.match(/profile launch/);
  });

  it('omits the PID parenthesis when pid is undefined (Windows lockfile)', () => {
    const msg = formatProfileBusyMessage('Brave', undefined);
    expect(msg).to.match(/^Brave is already running\. /);
    expect(msg).to.not.include('(PID');
    expect(msg).to.match(/Quit it first/);
  });

  it('omits the PID parenthesis when pid is 0 (defensive)', () => {
    // A PID of 0 is meaningless on POSIX (kernel-reserved) and on Windows.
    // The truthy check below the message build collapses both to the
    // no-PID form — verify.
    const msg = formatProfileBusyMessage('Edge', 0);
    expect(msg).to.not.include('(PID');
  });

  it('mentions the source browser by display name (not internal key)', () => {
    expect(formatProfileBusyMessage('Brave', 1)).to.include('Brave');
    expect(formatProfileBusyMessage('Microsoft Edge', 2)).to.include(
      'Microsoft Edge',
    );
  });
});
