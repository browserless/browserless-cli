import { Command } from 'commander';
import { DISCLAIMER_TEXT } from '../../auth/disclaimer.js';

export const registerTerms = (parent: Command): void => {
  parent
    .command('terms')
    .description('Print the liability disclaimer shown before a profile upload')
    .action(() => {
      process.stdout.write(DISCLAIMER_TEXT.trim() + '\n');
    });
};
