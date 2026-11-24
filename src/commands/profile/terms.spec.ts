import { expect } from 'chai';
import { Command } from 'commander';
import sinon from 'sinon';
import { DISCLAIMER_TEXT } from '../../auth/disclaimer.js';
import { registerTerms } from './terms.js';

describe('commands/profile/terms', () => {
  afterEach(() => sinon.restore());

  it('prints exactly the disclaimer to stdout without network calls or failure', async () => {
    const stdout = sinon.stub(process.stdout, 'write').returns(true);
    const stderr = sinon.stub(process.stderr, 'write').returns(true);
    const fetch = sinon.stub(globalThis, 'fetch');
    const program = new Command();
    registerTerms(program);

    await program.parseAsync(['terms'], { from: 'user' });

    expect(
      stdout
        .getCalls()
        .map((call) => call.args[0])
        .join(''),
    ).to.equal(DISCLAIMER_TEXT.trim() + '\n');
    expect(stderr.called).to.equal(false);
    expect(fetch.called).to.equal(false);
    expect(process.exitCode ?? 0).to.equal(0);
  });
});
