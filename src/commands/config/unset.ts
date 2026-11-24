import { Command } from 'commander';
import { updateConfig } from '../../config/store.js';
import { validateUnset } from '../../config/schema.js';

const action = async (key: string): Promise<void> => {
  const valid = validateUnset(key);
  await updateConfig((c) => {
    delete (c as Record<string, unknown>)[valid];
  });
  console.log(`✓ Unset ${valid}`);
};

export const registerConfigUnset = (parent: Command): void => {
  parent
    .command('unset <key>')
    .description('Remove a config value, falling back to its default')
    .action(action);
};
