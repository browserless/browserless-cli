import os from 'node:os';
import path from 'node:path';

/**
 * Resolve the on-disk location of `~/.browserless/`.
 *
 * On all three OSes we use the user's home directory rather than an XDG /
 * `%APPDATA%` variant — the directory is small, semantically owned by the
 * user (not the OS), and its location appears in disclaimer copy and CLI
 * help text. A predictable home-relative path keeps that copy honest.
 *
 * `BROWSERLESS_CONFIG_DIR` overrides the location for CI / multi-tenant
 * setups that want to isolate config without overriding `$HOME` (which
 * breaks Chrome's macOS-Library startup probes when set to a fresh
 * tmpdir — Chrome hangs in Launch Services / XPC handshake).
 */
export const configDir = (): string =>
  process.env.BROWSERLESS_CONFIG_DIR ||
  path.join(os.homedir(), '.browserless');

export const configFile = (): string => path.join(configDir(), 'config.json');

export const customBrowsersFile = (): string =>
  path.join(configDir(), 'custom-browsers.json');
