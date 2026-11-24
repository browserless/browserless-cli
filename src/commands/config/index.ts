import { Command } from 'commander';
import { registerConfigGet } from './get.js';
import { registerConfigSet } from './set.js';
import { registerConfigUnset } from './unset.js';

export const registerConfig = (parent: Command): void => {
  const cmd = parent
    .command('config')
    .description('Read or write CLI configuration values');
  registerConfigGet(cmd);
  registerConfigSet(cmd);
  registerConfigUnset(cmd);
};
