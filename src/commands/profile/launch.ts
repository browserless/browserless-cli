import { Command } from 'commander';
import { printJson } from '../../cli-utils/client.js';
import { resolveProfile } from '../../browsers/discover.js';
import { checkProfileLock } from '../../browsers/lock.js';
import {
  fetchCdpMetadata,
  killBrowser,
  launchBrowser,
  pickFreePort,
  waitForDebuggerEndpoint,
} from '../../capture/launch.js';
import { PreconditionError, UsageError } from '../../errors.js';

interface Options {
  browser?: string;
  profile?: string;
  headless?: boolean;
  passwordStore?: string;
  json?: boolean;
}

/**
 * Build the user-facing message for the "source browser still running"
 * pre-flight failure. Extracted as a pure helper so the PID-present /
 * PID-absent (Windows) branches are unit-testable without spinning up a
 * real browser.
 */
export const formatProfileBusyMessage = (
  browserDisplayName: string,
  pid: number | undefined,
): string => {
  // `pid` is undefined on Windows (the lockfile is an empty marker; the
  // real mutex is a Win32 named mutex). Only mention the PID when present.
  const pidNote = pid ? ` (PID ${pid})` : '';
  return (
    `${browserDisplayName} is already running${pidNote}. ` +
    `Quit it first (⌘Q on macOS) and re-run \`browserless profile launch\`. ` +
    `\`profile launch\` boots a fresh process against your real profile dir, so the source browser must be closed.`
  );
};

const action = async (opts: Options): Promise<void> => {
  if (!opts.browser || !opts.profile) {
    throw new UsageError(
      '--browser and --profile are required',
      'missing-required-flag',
    );
  }
  const detected = await resolveProfile(opts.browser, opts.profile);

  // Use the user's real --user-data-dir directly so cookies are live (no
  // staleness from a copy-time snapshot). This means the launched browser
  // shares state with the user's normal browser, which conflicts if it's
  // already running — Chromium's Singleton mechanism would otherwise have
  // our launch hijack the existing process or silently exit. Detect and
  // refuse with a friendly message.
  const lock = await checkProfileLock(detected.userDataDir);
  if (lock.locked) {
    throw new PreconditionError(
      formatProfileBusyMessage(detected.browserDisplayName, lock.pid),
      'profile-busy',
    );
  }

  const port = await pickFreePort();
  const { child, passwordStoreDefaulted, diagnostics } = await launchBrowser({
    profile: detected,
    userDataDir: detected.userDataDir,
    port,
    headless: !!opts.headless,
    passwordStoreOverride: opts.passwordStore,
  });

  let shuttingDown = false;
  const cleanup = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write('\n> Shutting down browser\n');
    await killBrowser(child);
    // Intentionally no fs.rm — we're using the user's real profile dir,
    // not a temp copy. Anything they did in the launched window
    // (browsing history, new logins, settings) is already persisted to
    // their actual profile, which is the whole point.
  };

  // Forward Ctrl-C / SIGTERM / Ctrl-Break to a clean shutdown so the
  // launched browser process tree is terminated (Windows uses taskkill via
  // killBrowser). Once cleanup is done the CLI exits with the conventional
  // signal-derived exit code (130 for SIGINT, 143 for SIGTERM).
  //
  // SIGBREAK handles Windows Ctrl-Break + programmatic CTRL_BREAK_EVENT.
  // Unlike CTRL_C_EVENT (which Win32 only broadcasts to the whole console),
  // CTRL_BREAK_EVENT can be targeted at a specific process group, making
  // it the only way to deliver a *graceful* shutdown signal to this CLI
  // when invoked as a detached child process. We treat it identically to
  // SIGINT.
  const signalHandler = (code: number) => () => {
    cleanup().finally(() => process.exit(code));
  };
  process.once('SIGINT', signalHandler(130));
  process.once('SIGTERM', signalHandler(143));
  process.once('SIGBREAK', signalHandler(130));

  try {
    await waitForDebuggerEndpoint(port, undefined, diagnostics);
    const meta = await fetchCdpMetadata(port);

    if (opts.json) {
      printJson({
        pid: child.pid,
        httpEndpoint: `http://127.0.0.1:${port}`,
        webSocketDebuggerUrl: meta.webSocketDebuggerUrl,
        browser: meta.Browser,
        userDataDir: detected.userDataDir,
        profileDirectory: detected.profileDirName,
        headless: !!opts.headless,
      });
    } else {
      process.stderr.write(`> Browser running (PID ${child.pid})\n`);
      process.stderr.write(`  ${meta.Browser}\n`);
      process.stderr.write(`  HTTP endpoint:    http://127.0.0.1:${port}\n`);
      process.stderr.write(
        `  WebSocket:        ${meta.webSocketDebuggerUrl}\n`,
      );
      if (passwordStoreDefaulted) {
        process.stderr.write(
          `  ! Linux password-store could not be detected — defaulted to "basic". If sites that need stored passwords don't work, re-run with --password-store=<your store>\n`,
        );
      }
      process.stderr.write(
        `\nNote: this is your real ${detected.browserDisplayName} profile — anything you do here persists.\n`,
      );
      process.stderr.write(
        `Press Ctrl-C to stop, or fully quit the browser (cmd-Q on macOS).\n`,
      );
    }

    // Block until the launched browser exits on its own (user closes /
    // quits) or we forward a signal.
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    process.stderr.write('> Browser exited\n');
  } finally {
    await cleanup();
  }
};

export const registerLaunch = (parent: Command): void => {
  parent
    .command('launch')
    .description(
      'Launch a local browser using your existing profile. Source browser must be closed; changes made in the launched window persist back to your real profile.',
    )
    .requiredOption(
      '--browser <key>',
      'Source browser key (chrome / brave / edge / ...) or display name',
    )
    .requiredOption(
      '--profile <name>',
      'Source profile display name or directory',
    )
    .option('--headless', 'Run the browser with no visible window')
    .option(
      '--password-store <store>',
      'Linux only: --password-store value to pass through to the launched browser',
    )
    .option(
      '--json',
      'Print the launched browser metadata (PID, CDP URLs) as JSON',
    )
    .action(action);
};
