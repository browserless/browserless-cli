import { PreconditionError, UsageError } from '../errors.js';
import { isLoopbackHostname } from '../utils/loopback.js';

export const ALLOW_INSECURE_ENV = 'BROWSERLESS_ALLOW_INSECURE_HTTP';

export const assertSecureServerUrl = (server: string): string => {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new UsageError(
      `server must be a valid URL (got "${server}")`,
      'invalid-server-url',
    );
  }
  if (url.protocol === 'https:') return server;
  if (url.protocol === 'http:') {
    if (isLoopbackHostname(url.hostname)) return server;
    if (process.env[ALLOW_INSECURE_ENV] === '1') {
      process.stderr.write(
        `warning: sending your Browserless token over unencrypted http:// to ${url.host} (BROWSERLESS_ALLOW_INSECURE_HTTP is set)\n`,
      );
      return server;
    }
    throw new PreconditionError(
      `Refusing to send your Browserless token over unencrypted http:// to ${url.host}. Use https://, or set BROWSERLESS_ALLOW_INSECURE_HTTP=1 to override.`,
      'insecure-server-url',
    );
  }
  throw new UsageError(
    `server must use https:// (got "${url.protocol}")`,
    'unsupported-server-scheme',
  );
};
