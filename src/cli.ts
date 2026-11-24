#!/usr/bin/env node
import { Command } from 'commander';
import { version } from './version.js';
import { registerProfile } from './commands/profile/index.js';
import { registerAuth } from './commands/auth/index.js';
import { registerConfig } from './commands/config/index.js';
import { registerAgent } from './commands/agent/index.js';
import { exitCodeFor, UserFacingError } from './errors.js';
import * as telemetry from './telemetry/index.js';
import { terminalSafe } from './utils/terminal.js';

const program = new Command();
program
  .name('browserless')
  .description('Browserless CLI — manage profiles, sessions, and more.')
  .version(version);

registerProfile(program);
registerAuth(program);
registerConfig(program);
registerAgent(program);

const isProfileTerms = (cmd: Command): boolean =>
  cmd.name() === 'terms' && cmd.parent?.name() === 'profile';

program.hook('preAction', (_thisCommand, actionCommand) => {
  if (isProfileTerms(actionCommand)) return;
  // The telemetry calls run on the command's critical path; each is guarded so
  // a future edit here can never fail the command or override its exit code.
  try {
    telemetry.begin(actionCommand);
  } catch {
    // best-effort
  }
});

program.hook('postAction', async (_thisCommand, actionCommand) => {
  if (isProfileTerms(actionCommand)) return;
  try {
    await telemetry.complete({ status: 'ok', exitCode: 0 });
  } catch {
    // best-effort
  }
});

program.parseAsync(process.argv).catch(async (err: unknown) => {
  if (err instanceof UserFacingError) {
    process.stderr.write(
      `${terminalSafe(err.message, { preserveLayout: true })}\n`,
    );
  } else if (err instanceof Error) {
    process.stderr.write(
      `${terminalSafe(err.stack ?? err.message, { preserveLayout: true })}\n`,
    );
  } else {
    process.stderr.write(`${terminalSafe(err, { preserveLayout: true })}\n`);
  }
  // Set the code and let the event loop drain rather than calling
  // process.exit(). After a capture, the spawned browser has been killed
  // but libuv may still have the child's pipe/async handles queued for
  // close, and stderr is async when piped. process.exit() begins tearing
  // those handles down while a uv_async_send is still queued against one,
  // which aborts the process on Windows (uv_async_send asserts
  // !UV_HANDLE_CLOSING — STATUS_STACK_BUFFER_OVERRUN / 0xC0000409). The
  // success path already exits cleanly via natural drain; this mirrors it.
  process.exitCode = exitCodeFor(err);
  try {
    await telemetry.complete(telemetry.errorResult(err, process.exitCode));
  } catch {
    // Telemetry must never override the command's exit code.
  }
});
