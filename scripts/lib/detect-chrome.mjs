/**
 * Locate an installed Chrome binary the smoke tests can drive directly.
 * Used by cli-capture-smoke + cli-launch-smoke. Returns the absolute
 * path to the first candidate that exists, or `null` if Chrome isn't
 * installed in any of the standard locations.
 *
 * The smoke scripts register this binary as a *custom* browser source
 * rather than relying on the CLI's built-in discovery — the runner's
 * real user profile is off-limits, so we point `--browser` at a freshly
 * seeded fake user-data-dir.
 */
import { existsSync } from 'node:fs';

const CANDIDATES = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/google-chrome',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export const detectChromeBinary = () => {
  const candidates = CANDIDATES[process.platform] ?? [];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
};
