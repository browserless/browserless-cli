import { Command } from 'commander';
import {
  addClientFlags,
  buildClient,
  parseNonNegativeInt,
  printJson,
} from '../../cli-utils/client.js';
import { listProfiles } from '../../api/profiles.js';
import { terminalSafe } from '../../utils/terminal.js';

interface Options {
  token?: string;
  server?: string;
  region?: string;
  limit?: string;
  offset?: string;
  json?: boolean;
}

const action = async (opts: Options): Promise<void> => {
  const client = await buildClient(opts);
  const limit =
    opts.limit !== undefined
      ? parseNonNegativeInt('--limit', opts.limit, 1)
      : undefined;
  const offset =
    opts.offset !== undefined
      ? parseNonNegativeInt('--offset', opts.offset)
      : undefined;
  const profiles = await listProfiles(client, { limit, offset });

  if (opts.json) {
    printJson(profiles);
    return;
  }

  if (profiles.length === 0) {
    console.log('No profiles found.');
    return;
  }

  const header = ['NAME', 'COOKIES', 'ORIGINS', 'UPDATED', 'LAST USED'];
  const rows = profiles.map((p) =>
    [
      p.name,
      String(p.cookieCount),
      String(p.originCount),
      p.updatedAt,
      p.lastUsedAt ?? '-',
    ].map((value) => terminalSafe(value)),
  );
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const print = (row: string[]) =>
    console.log(row.map((c, i) => c.padEnd(widths[i])).join('  '));

  print(header);
  for (const row of rows) print(row);
};

export const registerList = (parent: Command): void => {
  const cmd = parent
    .command('list')
    .description('List cloud profiles owned by the current token')
    .option('--limit <n>', 'Maximum profiles to return')
    .option('--offset <n>', 'Pagination offset');
  addClientFlags(cmd).action(action);
};
