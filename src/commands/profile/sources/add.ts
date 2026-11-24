import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { addCustomBrowser } from '../../../browsers/custom.js';
import { findBuiltInByKeyOrName } from '../../../browsers/registry.js';
import { UsageError } from '../../../errors.js';

interface Options {
  name?: string;
  path?: string;
  userDataDir?: string;
}

const action = async (opts: Options): Promise<void> => {
  if (!opts.name || !opts.path || !opts.userDataDir) {
    throw new UsageError(
      'profile sources add requires --name, --path, and --user-data-dir',
    );
  }
  if (findBuiltInByKeyOrName(opts.name)) {
    throw new UsageError(
      `"${opts.name}" collides with a built-in browser. Pick a different name (e.g. "${opts.name}-custom").`,
    );
  }
  const binaryPath = path.resolve(opts.path);
  const userDataDir = path.resolve(opts.userDataDir);
  // Pre-flight: catch typos at registration time rather than letting
  // them surface later as "no detected profiles". A typo would otherwise
  // sit in custom-browsers.json indefinitely, hidden from `sources list`
  // (modulo the broken-entry surfacing) and only discovered via a failed
  // capture attempt.
  const [binaryStat, userDataDirStat] = await Promise.all([
    fs.stat(binaryPath).catch(() => null),
    fs.stat(userDataDir).catch(() => null),
  ]);
  if (!binaryStat) {
    throw new UsageError(`--path does not exist: ${opts.path}`);
  }
  if (binaryStat.isDirectory()) {
    throw new UsageError(
      `--path must point at a binary, not a directory: ${opts.path}`,
    );
  }
  if (!userDataDirStat) {
    throw new UsageError(`--user-data-dir does not exist: ${opts.userDataDir}`);
  }
  if (!userDataDirStat.isDirectory()) {
    throw new UsageError(
      `--user-data-dir must point at a directory: ${opts.userDataDir}`,
    );
  }
  await addCustomBrowser({
    name: opts.name,
    binaryPath,
    userDataDir,
  });
  console.log(`✓ Registered custom browser "${opts.name}"`);
};

export const registerSourcesAdd = (parent: Command): void => {
  parent
    .command('add')
    .description('Register a custom Chromium binary as a profile source')
    .requiredOption('--name <name>', 'Identifier (also used as --browser key)')
    .requiredOption('--path <path>', 'Path to the browser binary')
    .requiredOption(
      '--user-data-dir <dir>',
      "Path to the browser's user-data-dir",
    )
    .action(action);
};
