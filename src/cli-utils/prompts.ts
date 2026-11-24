import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const READLINE_HISTORY_SIZE = 200;

/** Testable prompt seam backed by Node readline. */
export interface Prompts {
  /**
   * Read one line of typed input from the user. The default implementation
   * uses readline with history enabled — up/down arrows recall previous task
   * prompts. Use for top-level conversational input only.
   */
  line(prompt: string): Promise<string>;
  /**
   * Like `line` but with history disabled. Use for prompts whose answer
   * shouldn't land on disk — MFA codes, anything the user wouldn't
   * want a `cat ~/.browserless/agent_history` to surface.
   */
  linePrivate(prompt: string): Promise<string>;
}

/**
 * Build the default production prompts. `line(...)` uses readline with history
 * (arrow-key recall, persisted best-effort); `linePrivate(...)` disables it so
 * MFA codes never land on disk.
 *
 * `out` is where prompt text is written. In
 * `--json` mode it must be stderr — stdout is reserved for the final JSON
 * payload, and prompt chrome on stdout would interleave with it.
 */
export const buildPrompts = (
  history: string[],
  persist: (entries: string[]) => Promise<void>,
  out: NodeJS.WriteStream = output,
  inp: NodeJS.ReadStream = input,
): Prompts => ({
  async line(promptText) {
    const rl = readline.createInterface({
      input: inp,
      output: out,
      history,
      historySize: READLINE_HISTORY_SIZE,
      removeHistoryDuplicates: true,
    });
    try {
      const answer = (await rl.question(promptText)).trim();
      // readline already mutated `history` (prepended the new line); persist
      // best-effort so the chat keeps moving even if the disk is full / RO.
      persist(history).catch(() => undefined);
      return answer;
    } finally {
      rl.close();
    }
  },
  async linePrivate(promptText) {
    const rl = readline.createInterface({ input: inp, output: out });
    try {
      return (await rl.question(promptText)).trim();
    } finally {
      rl.close();
    }
  },
});
