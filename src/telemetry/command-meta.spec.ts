import { expect } from 'chai';
import { Command } from 'commander';
import { commandPath, usedFlagNames } from './command-meta.js';

// Build a real commander tree, parse argv, and return the action command —
// the same object the preAction hook hands to these helpers.
const captureFrom = (argv: string[]): Command => {
  const program = new Command();
  program.exitOverride();
  let captured: Command | undefined;
  program
    .command('profile')
    .command('upload')
    .option('--json')
    .option('--name <name>')
    .option('--server <url>')
    .option('--token <token>')
    .option(
      '--exclude-domain <domain>',
      'repeatable',
      (value: string, acc: string[]) => [...acc, value],
      [] as string[],
    )
    // Commander passes the action command as the last argument.
    .action((_options: unknown, command: Command) => {
      captured = command;
    });
  program.parse(argv, { from: 'user' });
  if (!captured) throw new Error('action was not invoked');
  return captured;
};

describe('telemetry/command-meta', () => {
  it('commandPath returns the full noun-verb path', () => {
    expect(commandPath(captureFrom(['profile', 'upload', '--json']))).to.equal(
      'profile upload',
    );
  });

  it('commandPath handles a single-segment top-level command', () => {
    const program = new Command();
    program.exitOverride();
    let captured: Command | undefined;
    program.command('agent').action((_options: unknown, command: Command) => {
      captured = command;
    });
    program.parse(['agent'], { from: 'user' });
    if (!captured) throw new Error('action was not invoked');
    expect(commandPath(captured)).to.equal('agent');
  });

  it('usedFlagNames returns only the flags the user passed — names only', () => {
    const cmd = captureFrom([
      'profile',
      'upload',
      '--json',
      '--name',
      'secret-name',
    ]);
    expect(usedFlagNames(cmd).sort()).to.deep.equal(['json', 'name']);
    // The privacy invariant: a flag's *value* must never appear.
    expect(usedFlagNames(cmd)).to.not.include('secret-name');
  });

  it('usedFlagNames excludes flags left at their defaults', () => {
    // --server / --name were not passed → not reported.
    expect(usedFlagNames(captureFrom(['profile', 'upload', '--json']))).to.deep.equal(
      ['json'],
    );
  });

  it('reports --token by name only — never the token value', () => {
    const cmd = captureFrom(['profile', 'upload', '--token', 'sk-supersecret']);
    expect(usedFlagNames(cmd)).to.include('token');
    expect(usedFlagNames(cmd)).to.not.include('sk-supersecret');
  });

  it('reports repeated --exclude-domain by name only — never the domains', () => {
    const cmd = captureFrom([
      'profile',
      'upload',
      '--exclude-domain',
      'chase.com',
      '--exclude-domain',
      'okta.com',
    ]);
    const flags = usedFlagNames(cmd);
    expect(flags).to.include('excludeDomain');
    expect(flags).to.not.include('chase.com');
    expect(flags).to.not.include('okta.com');
  });
});
