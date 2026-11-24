import { expect } from 'chai';

/**
 * Assert that `fn()` rejects with an instance of `ErrorClass` and,
 * optionally, that the message matches `messageMatcher`. Returns the
 * thrown error typed as `E` so the caller can assert on structured
 * fields (e.g. `.code`, `.status`) without an extra cast.
 *
 * Uses `expect.fail` on the no-throw branch so Mocha output points at
 * the call site, not at this helper.
 */
export const expectRejects = async <E extends Error>(
  fn: () => Promise<unknown>,
  ErrorClass: new (...args: never[]) => E,
  messageMatcher?: RegExp | string,
): Promise<E> => {
  let caught: unknown;
  let didThrow = false;
  try {
    await fn();
  } catch (err) {
    didThrow = true;
    caught = err;
  }
  if (!didThrow) {
    expect.fail(`expected fn() to reject with ${ErrorClass.name}, but it resolved`);
  }
  expect(caught).to.be.instanceOf(ErrorClass);
  const err = caught as E;
  if (messageMatcher !== undefined) {
    if (typeof messageMatcher === 'string') {
      expect(err.message).to.include(messageMatcher);
    } else {
      expect(err.message).to.match(messageMatcher);
    }
  }
  return err;
};
