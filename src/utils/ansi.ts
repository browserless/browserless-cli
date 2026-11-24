/**
 * Minimal ANSI color helpers — no `chalk` dep. Color is suppressed when
 * `NO_COLOR` is set (https://no-color.org) or the *target stream* isn't a TTY,
 * so piping output stays clean. Each helper takes an optional stream so the
 * decision matches where the text actually goes (e.g. stderr in `--json` mode);
 * it defaults to stdout. Mirrors `Spinner`, which gates on its own stream.
 */

const enabled = (stream: NodeJS.WriteStream): boolean =>
  !process.env.NO_COLOR && !!stream.isTTY;

const wrap =
  (code: string) =>
  (s: string, stream: NodeJS.WriteStream = process.stdout): string =>
    enabled(stream) ? `\x1b[${code}m${s}\x1b[0m` : s;

export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const gray = wrap('90');

export interface Colors {
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  gray(s: string): string;
}

/** Color helpers bound to one stream — gating follows that stream's TTY. */
export const colorsFor = (stream: NodeJS.WriteStream): Colors => ({
  dim: (s) => dim(s, stream),
  red: (s) => red(s, stream),
  green: (s) => green(s, stream),
  gray: (s) => gray(s, stream),
});
