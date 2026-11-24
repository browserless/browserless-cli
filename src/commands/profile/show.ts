import { Command } from 'commander';
import {
  addClientFlags,
  buildClient,
  printJson,
} from '../../cli-utils/client.js';
import { getProfile } from '../../api/profiles.js';
import { terminalSafe } from '../../utils/terminal.js';

interface Options {
  token?: string;
  server?: string;
  region?: string;
  json?: boolean;
}

const action = async (name: string, opts: Options): Promise<void> => {
  const client = await buildClient(opts);
  const profile = await getProfile(client, name);
  if (opts.json) {
    printJson(profile);
    return;
  }
  console.log(`name:        ${terminalSafe(profile.name)}`);
  console.log(`id:          ${terminalSafe(profile.id)}`);
  console.log(`cookies:     ${terminalSafe(profile.cookieCount)}`);
  console.log(`origins:     ${terminalSafe(profile.originCount)}`);
  console.log(`created:     ${terminalSafe(profile.createdAt)}`);
  console.log(`updated:     ${terminalSafe(profile.updatedAt)}`);
  console.log(`last used:   ${terminalSafe(profile.lastUsedAt ?? '-')}`);
};

export const registerShow = (parent: Command): void => {
  const cmd = parent
    .command('show <name>')
    .description("Show a single cloud profile's metadata");
  addClientFlags(cmd).action(action);
};
