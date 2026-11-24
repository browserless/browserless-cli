import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sinon from 'sinon';

export interface TempHome {
  /** Absolute path of the temp HOME. */
  path: string;
  /**
   * Ensure `~/.browserless/` exists inside the temp home and return its
   * absolute path. Useful for specs that need to seed a config file
   * *before* the production code has run — e.g. testing what happens
   * when `~/.browserless/config.json` already contains corrupt JSON on
   * first read.
   */
  ensureConfigDir: () => Promise<string>;
  /**
   * Write a raw string to `~/.browserless/<filename>`. Bypasses the
   * production read/write paths intentionally — tests use this to set
   * up the "user already has a file" precondition. Pair with
   * `readConfig` / `readCustomBrowsers` to assert how the production
   * code reacts.
   */
  writeRawConfig: (filename: string, content: string) => Promise<void>;
  /** Restore os.homedir + remove the temp dir. */
  cleanup: () => Promise<void>;
}

/**
 * Create a fresh temp directory and stub `os.homedir()` to return it.
 * Lets config / auth tests mutate `~/.browserless/` without touching the
 * developer's real home.
 */
export const setupTempHome = async (): Promise<TempHome> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserless-cli-test-'));
  const stub = sinon.stub(os, 'homedir').returns(dir);
  const configDir = path.join(dir, '.browserless');
  return {
    path: dir,
    ensureConfigDir: async () => {
      await fs.mkdir(configDir, { recursive: true });
      return configDir;
    },
    writeRawConfig: async (filename, content) => {
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, filename), content);
    },
    cleanup: async () => {
      stub.restore();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
};
