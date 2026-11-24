import { Command } from 'commander';
import { clearToken, resolveServer } from '../../auth/store.js';
import { addServerOverrideFlags } from '../../cli-utils/client.js';

interface Options {
  server?: string;
  region?: string;
}

const action = async (opts: Options): Promise<void> => {
  const server = await resolveServer({ server: opts.server, region: opts.region });
  await clearToken(server);
  console.log(`✓ Cleared stored credentials for ${server}`);
};

export const registerAuthLogout = (parent: Command): void => {
  const cmd = parent
    .command('logout')
    .description('Clear stored credentials for the configured server');
  addServerOverrideFlags(cmd).action(action);
};
