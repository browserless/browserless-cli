import { Command } from 'commander';
import { printJson } from '../../cli-utils/client.js';
import { addCaptureFlags, CaptureFlags, runCapture } from '../../cli-utils/capture-runner.js';

interface Options extends CaptureFlags {
  json?: boolean;
}

const action = async (opts: Options): Promise<void> => {
  const result = await runCapture({ flags: opts, requiresDisclaimer: false });
  if (opts.json) {
    printJson(result.state);
    return;
  }

  const byDomain = new Map<string, number>();
  for (const c of result.state.cookies) {
    byDomain.set(c.domain, (byDomain.get(c.domain) ?? 0) + 1);
  }
  const top = [...byDomain.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  console.log(`\nSummary:`);
  console.log(`  cookies:        ${result.state.cookies.length}`);
  console.log(`  origins:        ${result.state.origins.length}`);
  console.log(`  duration:       ${result.diagnostics.durationMs} ms`);
  console.log(`\nTop cookie domains:`);
  for (const [domain, count] of top) {
    console.log(`  ${count.toString().padStart(4)}  ${domain}`);
  }
  if (result.state.origins.length > 0) {
    console.log(`\nOrigins with stored data:`);
    for (const o of result.state.origins) {
      const ls = Object.keys(o.localStorage).length;
      const idb = o.indexedDBs?.length ?? 0;
      console.log(`  - ${o.origin}    (${ls} ls keys, ${idb} idb dbs)`);
    }
  }
};

export const registerInspect = (parent: Command): void => {
  const cmd = parent
    .command('inspect')
    .description(
      'Capture a local profile and print a summary without uploading',
    )
    .option('--json', 'Emit the captured state as JSON');
  addCaptureFlags(cmd).action(action);
};
