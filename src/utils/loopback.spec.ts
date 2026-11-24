import { expect } from 'chai';
import { isLoopbackHostname } from './loopback.js';

describe('isLoopbackHostname', () => {
  for (const hostname of [
    'localhost',
    'LOCALHOST',
    'app.localhost',
    '127.0.0.1',
    '127.10.20.30',
    '[::1]',
    '::1',
  ]) {
    it(`accepts ${hostname}`, () => {
      expect(isLoopbackHostname(hostname)).to.equal(true);
    });
  }
  for (const hostname of [
    'localhost.example.com',
    '127.0.0.1.nip.io',
    '10.0.0.5',
    '192.168.1.10',
    '0.0.0.0',
    'example.com',
    '::ffff:127.0.0.1',
  ]) {
    it(`rejects ${hostname}`, () => {
      expect(isLoopbackHostname(hostname)).to.equal(false);
    });
  }
});
