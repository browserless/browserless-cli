import { Command } from 'commander';
import {
  addClientFlags,
  buildClient,
  printJson,
} from '../../cli-utils/client.js';
import { renameProfile } from '../../api/profiles.js';
import { terminalSafe } from '../../utils/terminal.js';

interface Options {
  token?: string;
  server?: string;
  region?: string;
  json?: boolean;
}

const action = async (
  oldName: string,
  newName: string,
  opts: Options,
): Promise<void> => {
  const client = await buildClient(opts);
  const response = await renameProfile(client, oldName, newName);
  if (opts.json) {
    printJson(response);
    return;
  }
  console.log(
    `✓ Renamed "${terminalSafe(oldName)}" → "${terminalSafe(response.name)}"`,
  );
};

export const registerRename = (parent: Command): void => {
  const cmd = parent
    .command('rename <old> <new>')
    .description('Rename a cloud profile');
  addClientFlags(cmd).action(action);
};
