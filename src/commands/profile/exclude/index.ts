import { Command } from 'commander';
import { registerExcludeList } from './list.js';
import { registerExcludeAdd } from './add.js';
import { registerExcludeRm } from './rm.js';

export const registerProfileExclude = (parent: Command): void => {
  const cmd = parent
    .command('exclude')
    .description('Manage the persistent domain exclusion list');
  registerExcludeList(cmd);
  registerExcludeAdd(cmd);
  registerExcludeRm(cmd);
};
