import { expect } from 'chai';
import {
  ApiError,
  CaptureError,
  PreconditionError,
  UsageError,
  UserFacingError,
  errorCodeOf,
  errorTelemetryOf,
  exitCodeFor,
} from './errors.js';

describe('errors', () => {
  describe('errorTelemetryOf', () => {
    const cases: [unknown, string, string, number?][] = [
      [new UsageError('x', 'unknown-browser'), 'usage', 'unknown-browser'],
      [new UsageError('x'), 'usage', 'unknown'],
      [
        new PreconditionError('x', 'terms-not-accepted'),
        'precondition',
        'terms-not-accepted',
      ],
      [new PreconditionError('x'), 'precondition', 'unknown'],
      [
        new CaptureError('x', 'profile-copy-failed'),
        'capture',
        'profile-copy-failed',
      ],
      [new CaptureError('x'), 'capture', 'unknown'],
      [
        new ApiError('x', 0, undefined, 'request-timeout'),
        'network',
        'request-timeout',
      ],
      [
        new ApiError('x', 0, undefined, 'network-unreachable'),
        'network',
        'network-unreachable',
      ],
      [
        new ApiError('x', 0, undefined, 'response-read-failed'),
        'network',
        'response-read-failed',
      ],
      [
        new ApiError('x', 0, undefined, 'websocket-failed'),
        'network',
        'websocket-failed',
      ],
      [
        new ApiError('x', 0, undefined, 'websocket-not-open'),
        'network',
        'websocket-not-open',
      ],
      [
        new ApiError('x', 200, 't', 'invalid-response'),
        'api',
        'invalid-response',
        200,
      ],
      [
        new ApiError('x', 400, 'b', 'capture-settings-rejected'),
        'api',
        'capture-settings-rejected',
        400,
      ],
      [
        new ApiError('x', 0, undefined, 'agent-session-error'),
        'api',
        'agent-session-error',
      ],
      [
        new ApiError('x', 404, undefined, 'request-timeout'),
        'network',
        'request-timeout',
        404,
      ],
      ...(
        [
          [400, 'bad-request'],
          [401, 'unauthorized'],
          [403, 'forbidden'],
          [404, 'not-found'],
          [409, 'conflict'],
          [413, 'payload-too-large'],
          [429, 'rate-limited'],
          [422, 'client-error'],
          [499, 'client-error'],
          [500, 'server-error'],
          [503, 'server-error'],
          [599, 'server-error'],
          [302, 'http-error'],
          [399, 'http-error'],
          [600, 'http-error'],
        ] as [number, string][]
      ).map(([status, code]): [unknown, string, string, number] => [
        new ApiError('x', status),
        'api',
        code,
        status,
      ]),
      [new ApiError('x', 0), 'network', 'unknown'],
      [new UserFacingError('x'), 'internal', 'unknown'],
      [new Error('x'), 'internal', 'unknown'],
      [{ code: 'ECONNREFUSED' }, 'internal', 'ECONNREFUSED'],
      [{ code: 'bad code with spaces' }, 'internal', 'unknown'],
      [{ code: 'x'.repeat(65) }, 'internal', 'unknown'],
      [{ code: 'x'.repeat(64) }, 'internal', 'x'.repeat(64)],
      ['nope', 'internal', 'unknown'],
      [null, 'internal', 'unknown'],
    ];
    cases.forEach(([error, errorCategory, errorCode, httpStatus], index) => {
      it(`classifies case ${index}: ${errorCategory}/${errorCode}`, () => {
        expect(errorTelemetryOf(error)).to.deep.equal({
          errorName: error instanceof Error ? error.name : undefined,
          errorCategory,
          errorCode,
          httpStatus,
        });
      });
    });
    it('never reads messages or response bodies', () => {
      const error = new ApiError(
        'secret-profile /Users/a/b https://h.example?token=t',
        404,
        'secret-body',
      );
      for (const key of ['message', 'body']) {
        Object.defineProperty(error, key, {
          get: () => {
            throw new Error('private field read');
          },
        });
      }
      expect(JSON.stringify(errorTelemetryOf(error))).to.equal(
        '{"errorName":"ApiError","errorCode":"not-found","errorCategory":"api","httpStatus":404}',
      );
    });
  });

  it('UsageError exits 2', () => {
    expect(exitCodeFor(new UsageError('x'))).to.equal(2);
  });
  it('PreconditionError exits 3', () => {
    expect(exitCodeFor(new PreconditionError('x'))).to.equal(3);
  });
  it('CaptureError exits 4', () => {
    expect(exitCodeFor(new CaptureError('x'))).to.equal(4);
  });
  it('ApiError exits 5', () => {
    expect(exitCodeFor(new ApiError('x', 400))).to.equal(5);
  });
  it('Plain UserFacingError defaults to 1', () => {
    expect(exitCodeFor(new UserFacingError('x'))).to.equal(1);
  });
  it('Unknown errors default to 1', () => {
    expect(exitCodeFor(new Error('x'))).to.equal(1);
    expect(exitCodeFor('whatever')).to.equal(1);
  });

  describe('error codes', () => {
    it('PreconditionError carries an optional code', () => {
      const err = new PreconditionError('no token', 'no-token');
      expect(err.code).to.equal('no-token');
    });
    it('PreconditionError.code is undefined when not specified', () => {
      const err = new PreconditionError('x');
      expect(err.code).to.be.undefined;
    });
    it('CaptureError carries an optional code', () => {
      const err = new CaptureError('cdp timed out', 'cdp-timeout');
      expect(err.code).to.equal('cdp-timeout');
    });
    it('CaptureError.code is undefined when not specified', () => {
      const err = new CaptureError('x');
      expect(err.code).to.be.undefined;
    });
  });

  describe('errorCodeOf', () => {
    it('returns the code from a coded error', () => {
      expect(errorCodeOf(new PreconditionError('x', 'no-token'))).to.equal(
        'no-token',
      );
    });
    it('returns the code from a Node ErrnoException', () => {
      expect(errorCodeOf({ code: 'ECONNREFUSED' })).to.equal('ECONNREFUSED');
    });
    it('returns undefined for a code-less coded error (not "")', () => {
      expect(errorCodeOf(new PreconditionError('x'))).to.be.undefined;
    });
    it('returns undefined for an empty-string code', () => {
      expect(errorCodeOf({ code: '' })).to.be.undefined;
    });
    it('returns undefined for plain / non-object errors', () => {
      expect(errorCodeOf(new Error('x'))).to.be.undefined;
      expect(errorCodeOf('nope')).to.be.undefined;
      expect(errorCodeOf(null)).to.be.undefined;
    });
  });
});
