import { expect } from 'chai';
import {
  allConfigKeys,
  isKnownKey,
  validateScalarSet,
  validateUnset,
} from './schema.js';
import { UsageError } from '../errors.js';
import { expectRejects } from '../test-helpers/assertions.js';

describe('config/schema', () => {
  describe('isKnownKey', () => {
    it('accepts every key returned by allConfigKeys()', () => {
      for (const key of allConfigKeys()) {
        expect(isKnownKey(key)).to.be.true;
      }
    });
    it('rejects unknown keys', () => {
      expect(isKnownKey('does-not-exist')).to.be.false;
    });
  });

  describe('validateScalarSet', () => {
    it('rejects non-HTTP(S) server schemes', () => {
      for (const server of ['ftp://x', 'ws://x', 'wss://x', 'file:///tmp/x']) {
        expect(() => validateScalarSet('server', server)).to.throw(
          UsageError,
          /server must use https:\/\//,
        );
      }
    });
    it('accepts remote HTTP for enforcement at use time', () => {
      expect(validateScalarSet('server', 'http://10.0.0.5')).to.equal(
        'http://10.0.0.5',
      );
    });
    it('parses a server URL', () => {
      expect(validateScalarSet('server', 'https://example.com')).to.equal(
        'https://example.com',
      );
    });
    it('rejects a non-URL server', () => {
      expect(() => validateScalarSet('server', 'not a url')).to.throw(
        UsageError,
      );
    });
    it('parses a known region code', () => {
      expect(validateScalarSet('region', 'lon')).to.equal('lon');
    });
    it('rejects an unknown region code', () => {
      expect(() => validateScalarSet('region', 'zzz')).to.throw(
        UsageError,
        /region must be one of/,
      );
    });
    it('parses a positive integer for terms_ttl_days', () => {
      expect(validateScalarSet('terms_ttl_days', '14')).to.equal(14);
      expect(validateScalarSet('terms_ttl_days', '0')).to.equal(0);
    });
    it('rejects non-integer / negative terms_ttl_days', () => {
      expect(() => validateScalarSet('terms_ttl_days', '-1')).to.throw(
        UsageError,
      );
      expect(() => validateScalarSet('terms_ttl_days', '1.5')).to.throw(
        UsageError,
      );
      expect(() => validateScalarSet('terms_ttl_days', 'abc')).to.throw(
        UsageError,
      );
    });
    it('parses booleans for telemetry (and returns a real boolean)', () => {
      for (const truthy of ['true', '1', 'yes', 'on']) {
        expect(validateScalarSet('telemetry', truthy)).to.equal(true);
      }
      for (const falsy of ['false', '0', 'no', 'off']) {
        // Must coerce to a real boolean: isEnabled treats only boolean `true`
        // (or an absent key) as enabled, so a stored string like "true" would
        // wrongly disable telemetry the user meant to keep on.
        expect(validateScalarSet('telemetry', falsy)).to.equal(false);
      }
    });
    it('rejects a non-boolean telemetry value', () => {
      expect(() => validateScalarSet('telemetry', 'maybe')).to.throw(
        UsageError,
      );
    });
    it('refuses to set list keys via config set', () => {
      expect(() => validateScalarSet('excluded_domains', 'foo.com')).to.throw(
        UsageError,
        /profile exclude/,
      );
    });
    it('refuses to set CLI-managed keys', () => {
      expect(() => validateScalarSet('token_storage', 'keychain')).to.throw(
        UsageError,
      );
      expect(() =>
        validateScalarSet('accepted_terms_at', '2026-01-01'),
      ).to.throw(UsageError);
      expect(() => validateScalarSet('api_key', 'abc')).to.throw(UsageError);
    });
    it('rejects unknown keys with a key list hint', async () => {
      await expectRejects(
        async () => validateScalarSet('does-not-exist', 'value'),
        UsageError,
        /Known keys: server/,
      );
    });
  });

  describe('validateUnset', () => {
    it('accepts user-managed scalar keys', () => {
      expect(validateUnset('server')).to.equal('server');
      expect(validateUnset('terms_ttl_days')).to.equal('terms_ttl_days');
    });
    it('accepts user-managed list keys (unlike set)', () => {
      // unset is a clear-the-list operation — not the same trap as set.
      expect(validateUnset('excluded_domains')).to.equal('excluded_domains');
    });
    it('rejects CLI-managed keys', () => {
      expect(() => validateUnset('token_storage')).to.throw(UsageError);
      expect(() => validateUnset('api_key')).to.throw(UsageError);
    });
    it('rejects unknown keys', () => {
      expect(() => validateUnset('does-not-exist')).to.throw(UsageError);
    });
  });
});
