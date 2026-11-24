import { Command } from 'commander';
import {
  getTokenStorageMode,
  resolveServer,
  resolveToken,
} from '../../auth/store.js';
import { keychainAvailable } from '../../auth/keychain.js';
import { validateToken } from '../../api/auth.js';
import { addServerOverrideFlags } from '../../cli-utils/client.js';
import { PreconditionError } from '../../errors.js';

interface Options {
  server?: string;
  region?: string;
}

const action = async (opts: Options): Promise<void> => {
  const server = await resolveServer({ server: opts.server, region: opts.region });
  const storage = await getTokenStorageMode();
  const keychain = await keychainAvailable();

  console.log(`server:           ${server}`);
  console.log(`keychain support: ${keychain ? 'available' : 'unavailable'}`);
  console.log(`token storage:    ${storage}`);

  let resolved;
  try {
    resolved = await resolveToken({ server });
  } catch (err) {
    if (err instanceof PreconditionError) {
      console.log(`token:            (none — run \`browserless auth login\`)`);
      return;
    }
    throw err;
  }
  console.log(`token source:     ${resolved.source}`);
  const valid = await validateToken({ server, token: resolved.token });
  console.log(`token check:      ${valid ? 'valid' : 'rejected'}`);
};

export const registerAuthStatus = (parent: Command): void => {
  const cmd = parent
    .command('status')
    .description('Show which token slot is in use and where it is stored');
  addServerOverrideFlags(cmd).action(action);
};
