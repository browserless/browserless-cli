import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

/**
 * Resolve `%LOCALAPPDATA%` / `%APPDATA%` / `%ProgramFiles%` /
 * `%ProgramFiles(x86)%` on Windows, with conventional fallbacks when the
 * env var isn't set. These helpers are only meaningful under
 * `process.platform === 'win32'` — `registry.ts` calls them exclusively
 * inside `win32:` entries of each `BrowserSpec.userDataDirByPlatform` /
 * `binaryPathByPlatform` record, and `discover.ts` only reads the entry
 * matching the current platform. The eager evaluation at module load
 * therefore produces meaningless Windows-style paths on POSIX (e.g.
 * `~/AppData/Local`) but those values are never read, so the divergence
 * is invisible. Don't reuse these helpers in cross-platform code paths.
 */
export const winLocalAppData = (): string =>
  process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

export const winAppData = (): string =>
  process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');

export const winProgramFiles = (): string =>
  process.env['ProgramFiles'] ?? 'C:\\Program Files';

export const winProgramFilesX86 = (): string =>
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

export const home_ = (): string => home;
