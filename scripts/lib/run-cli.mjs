/**
 * Shared spawn helpers for the cli-*-smoke.mjs scripts.
 *
 * Every smoke script needs to invoke the installed `browserless` CLI as
 * a child process and collect stdout/stderr. The portability nuances —
 * Windows quoting, the `shell: true` requirement for `.cmd` shims, the
 * kill-on-timeout dance — are non-trivial and were duplicated across
 * every script before this module existed. Keep them here, single-source.
 *
 * Self-contained on purpose: this file uses only `node:child_process`
 * and is consumed directly by the .mjs smoke scripts at runtime. No
 * transpilation, no extra npm dep.
 */
import { spawn } from 'node:child_process';

/**
 * Quote a single argv entry for `spawn(..., { shell: true })` on Windows.
 *
 *   - `shell: false` + `browserless.cmd` errors EINVAL (Node 20+
 *     CVE-2024-27980 mitigation blocks direct .cmd spawn).
 *   - `shell: true` makes cmd.exe re-parse the concatenated command
 *     line, splitting any unquoted-space arg (e.g. `C:\Program Files`).
 *
 * Wrap in double-quotes when the arg is empty or contains whitespace /
 * cmd metacharacters; escape embedded double-quotes. Mirrors what
 * cross-spawn does.
 */
export const winQuote = (arg) => {
  if (arg === '' || /[\s&|<>^()'"`]/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
};

/**
 * Spawn the installed `browserless` CLI with `args`, collect stdout +
 * stderr, and resolve when the process exits.
 *
 * Returns `{ status, stdout, stderr, signal? }`. `status` is the process
 * exit code, or `null` if the child errored before exiting (in which
 * case `error` is also set).
 *
 * Options:
 *   - `timeoutMs` (default 20_000): SIGKILL after this many ms.
 *   - `env`: merged with `process.env`.
 *   - `stdin`: written to the child's stdin before closing.
 *   - `onChild(child)`: caller owns stdin when supplied.
 */
export const runCli = (args, opts = {}) =>
  new Promise((resolve) => {
    const useShell = process.platform === 'win32';
    const finalArgs = useShell ? args.map(winQuote) : args;
    const child = spawn('browserless', finalArgs, {
      // Smoke runs dogfood the real CLI — never let them emit usage analytics
      // to production. Forced on regardless of the host env (the literal sits
      // after ...process.env); a caller can still re-enable via opts.env.
      env: {
        ...process.env,
        BROWSERLESS_TELEMETRY_DISABLED: '1',
        ...(opts.env ?? {}),
      },
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    if (opts.onChild) {
      opts.onChild(child);
    } else if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 20_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, signal });
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: err });
    });
  });

/**
 * Spawn a long-running `browserless profile launch` and wait for its
 * readiness signal — the JSON object the CLI prints once before
 * blocking on the child browser. See `src/commands/profile/launch.ts`
 * for the full set of fields; this helper only requires `pid` and
 * `webSocketDebuggerUrl` to be present as readiness markers.
 *
 * Returns `{ parsed, child, stderr }`. Caller must kill `child` when
 * done. `stderr` is a function returning the accumulated stderr so far.
 */
export const spawnLaunch = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32';
    const finalArgs = useShell ? args.map(winQuote) : args;
    const child = spawn('browserless', finalArgs, {
      // Smoke runs dogfood the real CLI — never let them emit usage analytics
      // to production. Forced on regardless of the host env (the literal sits
      // after ...process.env); a caller can still re-enable via opts.env.
      env: {
        ...process.env,
        BROWSERLESS_TELEMETRY_DISABLED: '1',
        ...(opts.env ?? {}),
      },
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        reject(
          new Error(
            `profile launch did not produce JSON within ${opts.timeoutMs ?? 90_000}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      }
    }, opts.timeoutMs ?? 90_000);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      const trimmed = stdout.trim();
      if (!resolved && trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.pid && parsed.webSocketDebuggerUrl) {
            resolved = true;
            clearTimeout(timer);
            resolve({ parsed, child, stderr: () => stderr });
          }
        } catch {
          // not yet complete
        }
      }
    });
    child.once('exit', (code, signal) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(
          new Error(
            `profile launch exited (${code}, signal=${signal}) before producing JSON\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      }
    });
  });
