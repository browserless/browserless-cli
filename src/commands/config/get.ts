import { Command } from 'commander';
import { readConfig } from '../../config/store.js';
import {
  allConfigKeys,
  isKnownKey,
  isSensitiveKey,
} from '../../config/schema.js';
import { UsageError } from '../../errors.js';

interface Options {
  showSensitive?: boolean;
}

const action = async (key: string, opts: Options): Promise<void> => {
  if (!isKnownKey(key)) {
    throw new UsageError(
      `Unknown config key "${key}". Known keys: ${allConfigKeys().join(', ')}.`,
    );
  }
  const config = await readConfig();
  const value = (config as Record<string, unknown>)[key];
  if (value === undefined) {
    console.log('(unset)');
    return;
  }
  if (isSensitiveKey(key) && !opts.showSensitive) {
    console.log('(redacted — pass --show-sensitive to reveal)');
    return;
  }
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value));
};

export const registerConfigGet = (parent: Command): void => {
  parent
    .command('get <key>')
    .description('Read a config value')
    .option(
      '--show-sensitive',
      'Print sensitive values (api_key) verbatim instead of redacting',
    )
    .action(action);
};
