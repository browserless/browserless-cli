import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import type { DetectedProfile } from '../browsers/discover.js';
import { UsageError } from '../errors.js';
import { terminalSafe } from '../utils/terminal.js';

export type SourcePrompt = (question: string) => Promise<string>;

export interface SourcePickerSeams {
  prompt?: SourcePrompt;
  write?: (line: string) => void;
}

const defaultPrompt: SourcePrompt = async (question) => {
  const rl = createInterface({ input: stdin, output: stderr });
  const controller = new AbortController();
  // Closing readline on EOF does not settle a pending question by itself.
  rl.once('close', () => controller.abort());
  try {
    return await rl.question(question, { signal: controller.signal });
  } finally {
    rl.close();
  }
};

export const pickSourceProfile = async (
  candidates: [DetectedProfile, ...DetectedProfile[]],
  {
    prompt = defaultPrompt,
    write = (line) => stderr.write(`${line}\n`),
  }: SourcePickerSeams = {},
): Promise<DetectedProfile> => {
  const label = (p: DetectedProfile) =>
    `${terminalSafe(p.browserDisplayName)} / ${terminalSafe(p.profileDisplayName)} (${terminalSafe(p.profileDirName)})`;
  const count = candidates.length;
  if (count === 1) {
    write(`> Using ${label(candidates[0])}`);
    return candidates[0];
  }

  write('Which browser profile should be captured?');
  candidates.forEach((p, i) => write(`  ${i + 1}) ${label(p)}`));
  for (let attempt = 0; attempt < 3; attempt++) {
    let answer: string;
    try {
      answer = (await prompt(`Enter a number [1-${count}]: `)).trim();
    } catch {
      break;
    }
    if (/^[1-9][0-9]*$/.test(answer) && Number(answer) <= count) {
      return candidates[Number(answer) - 1];
    }
    if (attempt < 2) write(`Enter a number from 1 to ${count}.`);
  }
  throw new UsageError(
    'No browser profile chosen. Run the command again, or pass --browser and --profile.',
    'invalid-source-choice',
  );
};
