import { customBrowsersFile } from '../config/paths.js';
import { PreconditionError, UsageError } from '../errors.js';
import {
  readJsonFile,
  writeSecureJsonFile,
} from '../utils/json-file.js';

/**
 * User-supplied Chromium binary registered via
 * `browserless profile sources add`. The `name` doubles as both the
 * display name and the `--browser <key>` value.
 */
export interface CustomBrowser {
  name: string;
  binaryPath: string;
  userDataDir: string;
}

const isCustomBrowserShape = (v: unknown): v is CustomBrowser =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as CustomBrowser).name === 'string' &&
  typeof (v as CustomBrowser).binaryPath === 'string' &&
  typeof (v as CustomBrowser).userDataDir === 'string';

const isUnknownArray = (v: unknown): v is unknown[] => Array.isArray(v);

/**
 * Read the persisted custom-browsers list.
 *
 * Missing file → `[]` (the user just hasn't registered any). A corrupt or
 * non-array payload is a real error: returning `[]` would let the next
 * `addCustomBrowser` overwrite the file with a single fresh entry,
 * permanently losing whatever the user had. Surface the parse error so
 * they can rescue the file.
 *
 * Array-ness is checked by `readJsonFile` (its error says "must be a JSON
 * array"); per-entry shape is checked here (its error names the required
 * fields). Two-stage so the user sees the most specific message for
 * whichever shape they got wrong.
 */
export const readCustomBrowsers = async (): Promise<CustomBrowser[]> => {
  const file = customBrowsersFile();
  const parsed = await readJsonFile<unknown[]>(file, {
    defaults: [],
    validate: isUnknownArray,
    errorCode: 'invalid-custom-browsers-file',
    shapeHint: 'a JSON array',
  });
  if (!parsed.every(isCustomBrowserShape)) {
    throw new PreconditionError(
      `${file} contains entries that do not match the expected shape ` +
        `({ name, binaryPath, userDataDir }). Inspect and fix the file.`,
      'invalid-custom-browsers-file',
    );
  }
  return parsed as CustomBrowser[];
};

const writeCustomBrowsers = (browsers: CustomBrowser[]): Promise<void> =>
  writeSecureJsonFile(customBrowsersFile(), browsers);

export const addCustomBrowser = async (
  browser: CustomBrowser,
): Promise<void> => {
  const existing = await readCustomBrowsers();
  if (existing.some((b) => b.name.toLowerCase() === browser.name.toLowerCase())) {
    throw new UsageError(
      `A custom browser named "${browser.name}" is already registered. Use \`profile sources rm\` first.`,
    );
  }
  await writeCustomBrowsers([...existing, browser]);
};

export const removeCustomBrowser = async (name: string): Promise<boolean> => {
  const existing = await readCustomBrowsers();
  const filtered = existing.filter(
    (b) => b.name.toLowerCase() !== name.toLowerCase(),
  );
  if (filtered.length === existing.length) return false;
  await writeCustomBrowsers(filtered);
  return true;
};
