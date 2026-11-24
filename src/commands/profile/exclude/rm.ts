import { Command } from 'commander';
import { updateConfig } from '../../../config/store.js';
import { normalizeExclusion } from '../../../capture/exclusion.js';
import { UsageError } from '../../../errors.js';

const action = async (domain: string): Promise<void> => {
  const normalized = normalizeExclusion(domain);
  if (!normalized) {
    throw new UsageError(`"${domain}" is not a valid domain pattern.`);
  }
  let removed = false;
  await updateConfig((c) => {
    const before = c.excluded_domains ?? [];
    const after = before.filter((d) => d !== normalized);
    removed = after.length !== before.length;
    c.excluded_domains = after;
  });
  if (!removed) {
    throw new UsageError(`"${normalized}" was not in the exclusion list.`);
  }
  console.log(`✓ Removed "${normalized}" from the exclusion list`);
};

export const registerExcludeRm = (parent: Command): void => {
  parent
    .command('rm <domain>')
    .description('Remove a domain from the persistent exclusion list')
    .action(action);
};
