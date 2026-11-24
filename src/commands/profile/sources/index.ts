import { Command } from 'commander';
import { registerSourcesList } from './list.js';
import { registerSourcesAdd } from './add.js';
import { registerSourcesRm } from './rm.js';

export const registerProfileSources = (parent: Command): void => {
  const cmd = parent
    .command('sources')
    .description('Manage local browser sources used as upload origins');
  registerSourcesList(cmd);
  registerSourcesAdd(cmd);
  registerSourcesRm(cmd);
};
