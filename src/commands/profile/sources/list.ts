import { Command } from 'commander';
import { printJson } from '../../../cli-utils/client.js';
import {
  discoverProfiles,
  findBrokenCustomSources,
} from '../../../browsers/discover.js';

interface Options {
  json?: boolean;
}

const action = async (opts: Options): Promise<void> => {
  const [profiles, brokenCustoms] = await Promise.all([
    discoverProfiles(),
    findBrokenCustomSources(),
  ]);

  if (opts.json) {
    printJson({ profiles, brokenCustoms });
    return;
  }

  if (profiles.length === 0 && brokenCustoms.length === 0) {
    console.log(
      'No browser profiles detected. Use `profile sources add` to register a custom Chromium binary.',
    );
    return;
  }

  if (profiles.length > 0) {
    const grouped = profiles.reduce<Record<string, typeof profiles>>(
      (acc, p) => {
        const label = `${p.browserDisplayName} (${p.browserKey})`;
        (acc[label] ??= []).push(p);
        return acc;
      },
      {},
    );

    for (const [label, items] of Object.entries(grouped)) {
      console.log(`\n${label}`);
      for (const p of items) {
        console.log(
          `  ${p.profileDisplayName.padEnd(20)} (${p.profileDirName})    ${p.profilePath}`,
        );
      }
    }
  }

  if (brokenCustoms.length > 0) {
    console.log(
      `\nRegistered custom browsers with missing paths (run \`profile sources rm <name>\` to clean up):`,
    );
    for (const b of brokenCustoms) {
      const reasons: string[] = [];
      if (b.missingBinary) reasons.push(`binary not found: ${b.binaryPath}`);
      if (b.missingUserDataDir)
        reasons.push(`user-data-dir not found: ${b.userDataDir}`);
      console.log(`  ${b.name}`);
      for (const r of reasons) console.log(`    - ${r}`);
    }
  }
};

export const registerSourcesList = (parent: Command): void => {
  parent
    .command('list')
    .description('Show local browsers and profiles available for upload')
    .option('--json', 'Emit JSON')
    .action(action);
};
