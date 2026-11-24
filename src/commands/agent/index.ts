import { Command } from 'commander';
import { addClientFlags } from '../../cli-utils/client.js';
import { runAgentChat, type ChatOptions } from './chat.js';

/**
 * Register the `browserless agent [prompt]` top-level noun. No verbs — the
 * bare command opens an interactive chat (a top-level noun, not a
 * `profile login`-style verb).
 */
export const registerAgent = (parent: Command): void => {
  const cmd = parent
    .command('agent [prompt]')
    .description(
      'Interactive chat with the Browserless hosted agent. The LLM runs server-side; the browser is driven for you.',
    )
    .option(
      '--no-history',
      'Disable reading + writing ~/.browserless/agent_history',
    )
    .option(
      '--cloud-profile <name>',
      'Open every browser session with this saved cloud profile (see `browserless profile list`)',
    )
    .action((prompt: string | undefined, opts: Omit<ChatOptions, 'prompt'>) =>
      runAgentChat({ ...opts, prompt }),
    );
  addClientFlags(cmd);
};
