import { Command } from 'commander';
import { resolveServer, persistToken } from '../../auth/store.js';
import { validateToken } from '../../api/auth.js';
import { addServerOverrideFlags } from '../../cli-utils/client.js';
import { PreconditionError } from '../../errors.js';
import { recordToken } from '../../telemetry/token-cache.js';

const readFromStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8').trim();
};

interface Options {
  server?: string;
  region?: string;
}

const action = async (
  tokenArg: string | undefined,
  opts: Options,
): Promise<void> => {
  const server = await resolveServer({
    server: opts.server,
    region: opts.region,
  });
  let token = tokenArg?.trim();
  if (!token) {
    if (process.stdin.isTTY) {
      throw new PreconditionError(
        'Pass the token as an argument or pipe it via stdin: `echo $TOKEN | browserless auth login`',
        'no-token',
      );
    }
    token = await readFromStdin();
  }
  if (!token) {
    throw new PreconditionError('No token provided.', 'no-token');
  }

  const valid = await validateToken({ server, token });
  if (!valid) {
    throw new PreconditionError(
      `Token rejected by ${server} — double-check it and retry.`,
      'invalid-token',
    );
  }

  // Record the validated token so the post-command telemetry flush attributes
  // this login (the activation event). `login` doesn't go through resolveToken,
  // so without this the activation funnel would be invisible.
  recordToken({ token, server });

  const { mode, warning } = await persistToken({ server, token });
  console.log(
    mode === 'keychain'
      ? `✓ Token saved to OS keychain for ${server}`
      : `✓ Token saved to ~/.browserless/config.json for ${server}`,
  );
  if (warning) console.log(`! ${warning}`);
};

export const registerAuthLogin = (parent: Command): void => {
  const cmd = parent
    .command('login [token]')
    .description(
      'Validate and persist an API token. Without an argument it is read from stdin — prefer that: an argument shows up in the process list for other local users and in shell history.',
    );
  addServerOverrideFlags(cmd).action(action);
};
