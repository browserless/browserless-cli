import { Command } from 'commander';
import { loadSourceCandidates } from '../../browsers/discover.js';
import {
  addClientFlags,
  buildClient,
  printJson,
} from '../../cli-utils/client.js';
import {
  addCaptureFlags,
  buildCaptureSettings,
  CaptureFlags,
  hasResolvedSource,
  mergeStoredSettings,
  printEffectiveSettings,
  runCapture,
} from '../../cli-utils/capture-runner.js';
import { getProfile } from '../../api/profiles.js';
import { refreshProfile } from '../../api/refresh.js';
import { withProfileSetup } from '../../telemetry/profile-setup.js';
import { terminalSafe } from '../../utils/terminal.js';

interface Options extends CaptureFlags {
  attemptId?: string;
  token?: string;
  server?: string;
  region?: string;
  name?: string;
  json?: boolean;
}

const action = (opts: Options): Promise<void> =>
  withProfileSetup(opts.attemptId, 'refresh', async (setup) => {
    // Profile first: the settings must be in hand before the browser runs, and a 404
    // then surfaces before any capture work.
    const client = await buildClient(opts);
    const existing = await getProfile(client, opts.name!);
    // Read the opt-out from argv BEFORE merging: `mergeStoredSettings` also sets
    // `defaultExcludes: false` when replaying a stored list, so afterwards the two are
    // indistinguishable and the printout cannot tell whether the config was suppressed.
    const userOptedOut = opts.defaultExcludes === false;
    const flags = mergeStoredSettings(opts, existing.captureSettings);
    const stored = existing.captureSettings;
    const resolved = hasResolvedSource(stored?.cliVersion);
    const changedBrowser =
      resolved &&
      opts.browser !== undefined &&
      ((opts.profile === undefined && stored?.profile !== undefined) ||
        (opts.passwordStore === undefined &&
          stored?.passwordStore !== undefined)) &&
      (await loadSourceCandidates(opts.browser, opts.profile)).some(
        (p) => p.browserKey !== stored?.browser,
      );
    if (changedBrowser) {
      if (opts.profile === undefined) delete flags.profile;
      if (opts.passwordStore === undefined) delete flags.passwordStore;
    }
    printEffectiveSettings(flags, existing.captureSettings, { userOptedOut });

    const result = await runCapture({
      flags,
      requiresDisclaimer: true,
      missingSource: changedBrowser ? 'flags' : 'stored-settings',
      exactSource: resolved
        ? {
            browser: opts.browser === undefined,
            profile: opts.profile === undefined,
          }
        : undefined,
    });
    setup.ready();

    process.stderr.write(
      `> Refreshing profile "${opts.name}" on ${client.server}\n`,
    );
    setup.submit();
    const response = await refreshProfile(client, {
      attemptId: setup.attemptId,
      name: opts.name!,
      state: result.state,
      serialized: result.serialized,
      captureSettings: buildCaptureSettings(
        flags,
        result.diagnostics,
        'refresh',
        result.source,
      ),
    });

    if (opts.json) {
      printJson(response);
      return;
    }

    console.log(`✓ Profile "${terminalSafe(response.name)}" refreshed`);
    console.log(`  id:       ${terminalSafe(response.id)}`);
    console.log(`  cookies:  ${terminalSafe(response.cookieCount)}`);
    console.log(`  origins:  ${terminalSafe(response.originCount)}`);
    console.log(`  updated:  ${terminalSafe(response.updatedAt)}`);
  });

export const registerRefresh = (parent: Command): void => {
  const cmd = parent
    .command('refresh')
    .description(
      'Capture a local browser profile and replace an existing cloud profile in place',
    )
    .requiredOption(
      '--name <name>',
      'Name of the existing cloud profile to refresh',
    )
    .option('--attempt-id <UUID>', 'Optional setup correlation ID');
  addCaptureFlags(addClientFlags(cmd), { sourceOptional: true }).action(action);
};
