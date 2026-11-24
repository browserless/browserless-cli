import { Command } from 'commander';
import {
  addClientFlags,
  buildClient,
  printJson,
} from '../../cli-utils/client.js';
import { deleteProfile } from '../../api/profiles.js';
import { terminalSafe } from '../../utils/terminal.js';

interface Options {
  token?: string;
  server?: string;
  region?: string;
  json?: boolean;
}

const action = async (name: string, opts: Options): Promise<void> => {
  const client = await buildClient(opts);
  const response = await deleteProfile(client, name);
  if (opts.json) {
    printJson(response);
    return;
  }
  console.log(`✓ Deleted profile "${terminalSafe(response.name)}"`);
};

export const registerDelete = (parent: Command): void => {
  const cmd = parent
    .command('delete <name>')
    .description('Delete a cloud profile');
  addClientFlags(cmd).action(action);
};
