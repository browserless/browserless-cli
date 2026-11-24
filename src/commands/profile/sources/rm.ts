import { Command } from 'commander';
import { removeCustomBrowser } from '../../../browsers/custom.js';
import { UsageError } from '../../../errors.js';

const action = async (name: string): Promise<void> => {
  const removed = await removeCustomBrowser(name);
  if (!removed) {
    throw new UsageError(`No custom browser named "${name}" is registered.`);
  }
  console.log(`✓ Removed custom browser "${name}"`);
};

export const registerSourcesRm = (parent: Command): void => {
  parent
    .command('rm <name>')
    .description('Unregister a custom Chromium browser')
    .action(action);
};
