import { Command } from 'commander';
import {
  addClientFlags,
  buildClient,
  printJson,
} from '../../cli-utils/client.js';
import {
  addCaptureFlags,
  buildCaptureSettings,
  CaptureFlags,
  runCapture,
} from '../../cli-utils/capture-runner.js';
import { uploadProfile } from '../../api/upload.js';
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

interface UploadDeps {
  runCapture: typeof runCapture;
}

const defaultDeps: UploadDeps = { runCapture };

const action = (opts: Options, deps: UploadDeps): Promise<void> =>
  withProfileSetup(opts.attemptId, 'create', async (setup) => {
    const client = await buildClient(opts);
    const result = await deps.runCapture({
      flags: opts,
      requiresDisclaimer: true,
      missingSource: 'flags',
    });
    setup.ready();

    process.stderr.write(`> Uploading to ${client.server}\n`);
    setup.submit();
    const response = await uploadProfile(client, {
      attemptId: setup.attemptId,
      name: opts.name!,
      state: result.state,
      serialized: result.serialized,
      captureSettings: buildCaptureSettings(
        opts,
        result.diagnostics,
        'upload',
        result.source,
      ),
    });

    if (opts.json) {
      printJson(response);
      return;
    }

    console.log(`✓ Profile "${terminalSafe(response.name)}" uploaded`);
    console.log(`  id:       ${terminalSafe(response.id)}`);
    console.log(`  cookies:  ${terminalSafe(response.cookieCount)}`);
    console.log(`  origins:  ${terminalSafe(response.originCount)}`);
    console.log(`  created:  ${terminalSafe(response.createdAt)}`);
  });

export const registerUpload = (
  parent: Command,
  deps: UploadDeps = defaultDeps,
): void => {
  const cmd = parent
    .command('upload')
    .description(
      'Capture a local browser profile and upload it as a new cloud profile',
    )
    .requiredOption('--name <name>', 'Name for the new cloud profile')
    .option('--attempt-id <UUID>', 'Optional setup correlation ID');
  addCaptureFlags(addClientFlags(cmd)).action((opts: Options) =>
    action(opts, deps),
  );
};
