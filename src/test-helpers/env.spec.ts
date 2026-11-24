import { expect } from 'chai';
import { captureAndClear } from './env.js';

describe('test-helpers/env.captureAndClear', () => {
  // The whole reason this helper exists (vs naive `process.env[k] = saved[k]`)
  // is the delete-on-restore branch: a key that wasn't set originally must
  // come back unset, not set to the literal string 'undefined'.
  const VAR = '__BROWSERLESS_CLI_TEST_CAPTURE_AND_CLEAR__';

  afterEach(() => {
    delete process.env[VAR];
  });

  it('clears the key while captured', () => {
    process.env[VAR] = 'before';
    const restore = captureAndClear([VAR]);
    expect(process.env[VAR]).to.be.undefined;
    restore();
    expect(process.env[VAR]).to.equal('before');
  });

  it('restores a previously-set key to its original value', () => {
    process.env[VAR] = 'original';
    const restore = captureAndClear([VAR]);
    process.env[VAR] = 'mutated';
    restore();
    expect(process.env[VAR]).to.equal('original');
  });

  it('restores an originally-unset key by deleting (not by setting "undefined")', () => {
    // This is the core invariant — naive `process.env[k] = saved[k]`
    // would set the literal string 'undefined' here.
    delete process.env[VAR];
    const restore = captureAndClear([VAR]);
    process.env[VAR] = 'mutated';
    restore();
    expect(process.env[VAR]).to.be.undefined;
    expect(VAR in process.env).to.be.false;
  });

  it('handles multiple keys independently', () => {
    const A = `${VAR}_A`;
    const B = `${VAR}_B`;
    process.env[A] = 'a-was-set';
    delete process.env[B];
    const restore = captureAndClear([A, B]);
    expect(process.env[A]).to.be.undefined;
    expect(process.env[B]).to.be.undefined;
    process.env[A] = 'mutated';
    process.env[B] = 'mutated';
    restore();
    expect(process.env[A]).to.equal('a-was-set');
    expect(B in process.env).to.be.false;
    delete process.env[A];
  });
});
