import type { Command } from 'commander';

/** Full noun-verb path of a command, e.g. "profile upload" / "agent". */
export const commandPath = (cmd: Command): string => {
  const names: string[] = [];
  let current: Command | null = cmd;
  while (current && current.parent) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(' ');
};

/**
 * Names of the flags the user explicitly passed (source === 'cli', so defaults
 * are excluded) — names only, never values. This is the single enforcement
 * point for telemetry's "flag names only" invariant, so it's unit-tested
 * directly against a real commander Command.
 */
export const usedFlagNames = (cmd: Command): string[] =>
  Object.keys(cmd.opts()).filter(
    (key) => cmd.getOptionValueSource(key) === 'cli',
  );
