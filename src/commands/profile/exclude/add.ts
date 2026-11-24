import { Command } from 'commander';
import { updateConfig } from '../../../config/store.js';
import { normalizeExclusion } from '../../../capture/exclusion.js';
import { UsageError } from '../../../errors.js';

const action = async (domain: string): Promise<void> => {
  const normalized = normalizeExclusion(domain);
  if (!normalized) {
    throw new UsageError(`"${domain}" is not a valid domain pattern.`);
  }
  await updateConfig((c) => {
    const set = new Set(c.excluded_domains ?? []);
    set.add(normalized);
    c.excluded_domains = [...set];
  });
  console.log(`✓ Excluded "${normalized}" from future uploads`);
};

export const registerExcludeAdd = (parent: Command): void => {
  parent
    .command('add <domain>')
    .description('Append a domain to the persistent exclusion list')
    .action(action);
};
