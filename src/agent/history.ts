import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../config/paths.js';
import { writeSecureFile } from '../utils/json-file.js';

/** Hard cap on persisted entries. Matches the readline `historySize` we pass. */
export const MAX_HISTORY_ENTRIES = 200;

/** Default on-disk location: `$BROWSERLESS_CONFIG_DIR/agent_history`. */
export const defaultHistoryFile = (): string =>
  path.join(configDir(), 'agent_history');

/**
 * Load chat history from disk. Returns entries in the order Node's `readline`
 * expects — newest first. Missing file or read errors yield an empty array;
 * history is best-effort and must never block the chat from starting.
 */
export const loadHistory = async (
  file: string = defaultHistoryFile(),
): Promise<string[]> => {
  try {
    const data = await fs.readFile(file, 'utf-8');
    // On disk we store oldest-first (one entry per line, append-friendly);
    // readline wants newest-first, so reverse + cap.
    return data
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .reverse()
      .slice(0, MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
};

/**
 * Persist chat history to disk atomically (write to temp + rename). Adjacent
 * duplicates are collapsed so the user spamming the same prompt doesn't bloat
 * the file. `entries` is taken newest-first as readline maintains it.
 */
export const saveHistory = async (
  entries: ReadonlyArray<string>,
  file: string = defaultHistoryFile(),
): Promise<void> => {
  const cleaned: string[] = [];
  for (const raw of entries) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (cleaned[cleaned.length - 1] === trimmed) continue;
    cleaned.push(trimmed);
    if (cleaned.length >= MAX_HISTORY_ENTRIES) break;
  }
  // Persist oldest-first (shell-history convention) so `tail` shows the most
  // recent prompts and a new entry could be appended in-place if we ever
  // wanted an append path. We reverse from readline's newest-first ordering.
  const payload = `${cleaned.slice().reverse().join('\n')}\n`;
  await writeSecureFile(file, payload, { atomic: true });
};
