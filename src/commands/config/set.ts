import { Command } from 'commander';
import { updateConfig } from '../../config/store.js';
import { validateScalarSet } from '../../config/schema.js';

const action = async (key: string, value: string): Promise<void> => {
  const parsed = validateScalarSet(key, value);
  await updateConfig((c) => {
    (c as Record<string, unknown>)[key] = parsed;
  });
  console.log(`✓ Set ${key} = ${JSON.stringify(parsed)}`);
};

export const registerConfigSet = (parent: Command): void => {
  parent
    .command('set <key> <value>')
    .description('Write a scalar config value (server, region, terms_ttl_days)')
    .action(action);
};
