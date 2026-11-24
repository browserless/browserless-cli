import { Command } from 'commander';
import { registerAuthLogin } from './login.js';
import { registerAuthLogout } from './logout.js';
import { registerAuthStatus } from './status.js';

export const registerAuth = (parent: Command): void => {
  const cmd = parent
    .command('auth')
    .description('Authenticate with Browserless');
  registerAuthLogin(cmd);
  registerAuthLogout(cmd);
  registerAuthStatus(cmd);
};
