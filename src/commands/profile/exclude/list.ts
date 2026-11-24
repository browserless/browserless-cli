import { Command } from 'commander';
import { readConfig } from '../../../config/store.js';

const action = async (): Promise<void> => {
  const config = await readConfig();
  const list = config.excluded_domains ?? [];
  if (list.length === 0) {
    console.log('No excluded domains configured.');
    return;
  }
  for (const domain of list) console.log(domain);
};

export const registerExcludeList = (parent: Command): void => {
  parent
    .command('list')
    .description('Print the current persistent exclusion list')
    .action(action);
};
