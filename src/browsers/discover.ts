import fs from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BUILT_IN_BROWSERS, BrowserRegistryEntry } from './registry.js';
import { CustomBrowser, readCustomBrowsers } from './custom.js';
import { PreconditionError, UsageError } from '../errors.js';
import { pathExists } from '../utils/fs.js';
import { terminalSafe } from '../utils/terminal.js';

/**
 * One concrete on-disk profile that the user can capture from. Carries
 * everything `capture/` needs to launch the browser headless against a
 * filtered copy.
 */
export interface DetectedProfile {
  /** Short key — built-in registry key, or custom browser name. */
  browserKey: string;
  /** Display name from `Local State` or the custom-browser registration. */
  browserDisplayName: string;
  /** On-disk profile dir name (`Default`, `Profile 1`, ...). */
  profileDirName: string;
  /** User-visible profile name from `Local State`, or `profileDirName` if absent. */
  profileDisplayName: string;
  /** Root user-data-dir (`~/Library/Application Support/Google/Chrome`, ...). */
  userDataDir: string;
  /** Absolute path to the profile dir on disk. */
  profilePath: string;
  /** Browser binary to spawn. */
  binaryPath: string;
}

/**
 * A custom-browser registration whose `binaryPath` and/or `userDataDir`
 * no longer exist on disk. Surfaced by `sources list` so the user has
 * a signal (other than "no profiles detected") that their registration
 * has gone stale — typically because an apt/brew upgrade relocated the
 * binary, or they nuked the profile dir.
 */
export interface BrokenCustomSource {
  name: string;
  binaryPath: string;
  userDataDir: string;
  missingBinary: boolean;
  missingUserDataDir: boolean;
}

/**
 * Resolve a binary by command name via `which`. Returns the absolute
 * path on success, or null when the command isn't on PATH.
 *
 * Used as a Linux fallback when none of the hardcoded `/usr/bin/...`
 * candidates exist — covers Snap (`/snap/bin/google-chrome`), Flatpak
 * (`~/.local/share/flatpak/exports/bin/...`), Arch's `/opt/google/chrome/`,
 * `/usr/local/bin`, or anywhere else on PATH. Same approach browser-use
 * uses (`browser_use/skill_cli/utils.py:find_chrome_executable`).
 */
export const whichOnPath = (cmd: string): Promise<string | null> =>
  new Promise((resolve) => {
    const child = spawn('which', [cmd], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout?.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', () => resolve(null));
    child.on('exit', (code) =>
      resolve(code === 0 && out.trim() ? out.trim() : null),
    );
  });

const firstExistingPath = async (paths: string[]): Promise<string | null> => {
  for (const p of paths) {
    if (await pathExists(p)) return p;
  }
  return null;
};

const firstExistingBinary = async (paths: string[]): Promise<string | null> => {
  const direct = await firstExistingPath(paths);
  if (direct) return direct;
  // Linux fallback: try `which <basename>` for each candidate. Catches
  // Snap-installed Chrome (Ubuntu 22.04+), Flatpak, /opt installs, and
  // anywhere else on PATH the hardcoded /usr/bin paths miss. Only safe
  // for binary lookup — `which <some-data-dir-basename>` could return
  // a binary path that we'd then misinterpret as a directory.
  if (process.platform === 'linux') {
    for (const p of paths) {
      const cmd = path.basename(p);
      if (!cmd) continue;
      const found = await whichOnPath(cmd);
      if (found) return found;
    }
  }
  return null;
};

const readProfileDisplayNames = async (
  userDataDir: string,
): Promise<Record<string, string>> => {
  const localStatePath = path.join(userDataDir, 'Local State');
  try {
    const raw = await fs.readFile(localStatePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const infoCache = parsed?.profile?.info_cache ?? {};
    return Object.fromEntries(
      Object.entries<any>(infoCache).map(([dirName, info]) => [
        dirName,
        info?.name ?? dirName,
      ]),
    );
  } catch {
    return {};
  }
};

const looksLikeProfile = async (dir: string): Promise<boolean> =>
  (await pathExists(path.join(dir, 'Preferences'))) ||
  (await pathExists(path.join(dir, 'Cookies'))) ||
  (await pathExists(path.join(dir, 'Network', 'Cookies')));

const profilesUnder = async (
  userDataDir: string,
  binaryPath: string,
  browserKey: string,
  browserDisplayName: string,
): Promise<DetectedProfile[]> => {
  const displayNames = await readProfileDisplayNames(userDataDir);
  // EACCES / EIO / partially-corrupt user-data-dir shouldn't reject the
  // whole `discoverProfiles` promise — one unreadable browser source
  // would otherwise mask every other detected browser.
  let entries: Dirent[];
  try {
    entries = await fs.readdir(userDataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((e) => e.isDirectory())
    .filter((e) => e.name === 'Default' || /^Profile \d+$/.test(e.name));

  const results = await Promise.all(
    candidates.map(async (e): Promise<DetectedProfile | null> => {
      const profilePath = path.join(userDataDir, e.name);
      if (!(await looksLikeProfile(profilePath))) return null;
      return {
        browserKey,
        browserDisplayName,
        profileDirName: e.name,
        profileDisplayName: displayNames[e.name] ?? e.name,
        userDataDir,
        profilePath,
        binaryPath,
      };
    }),
  );

  return results.filter((p): p is DetectedProfile => p !== null);
};

const discoverBuiltIn = async (
  entry: BrowserRegistryEntry,
): Promise<DetectedProfile[]> => {
  const userDataDirEntry = entry.userDataDirByPlatform[process.platform];
  const candidateBinaries = entry.binaryPathByPlatform[process.platform] ?? [];
  if (!userDataDirEntry || candidateBinaries.length === 0) return [];
  const userDataDirCandidates = Array.isArray(userDataDirEntry)
    ? userDataDirEntry
    : [userDataDirEntry];
  const binaryPath = await firstExistingBinary(candidateBinaries);
  if (!binaryPath) return [];

  // Iterate the candidate user-data-dirs rather than stopping at the first
  // one that exists. Linux Chromium ships in two flavours (apt → ~/.config
  // /chromium, Snap → ~/snap/chromium/common/chromium); the apt path also
  // gets created by unrelated tools (browser extensions writing
  // NativeMessagingHosts/, IDEs, etc.) — so "directory exists" doesn't
  // imply "has profiles". Try each candidate and return the first that
  // yields any. Falling back rather than failing keeps Snap-only users
  // working when an empty `.config/chromium` is present.
  for (const candidate of userDataDirCandidates) {
    if (!(await pathExists(candidate))) continue;
    const profiles = await profilesUnder(
      candidate,
      binaryPath,
      entry.key,
      entry.displayName,
    );
    if (profiles.length > 0) return profiles;
  }
  return [];
};

const discoverCustom = async (
  entry: CustomBrowser,
): Promise<DetectedProfile[]> => {
  // The original cwd of legacy registrations is unknown. Resolving them
  // here could select a different executable or profile in today's cwd.
  if (
    !path.isAbsolute(entry.binaryPath) ||
    !path.isAbsolute(entry.userDataDir)
  ) {
    throw new PreconditionError(
      `Custom browser "${entry.name}" has relative paths. Remove it with \`profile sources rm <name>\` and re-register it with \`profile sources add\` from its original directory.`,
      'invalid-custom-browsers-file',
    );
  }
  if (!(await pathExists(entry.userDataDir))) return [];
  if (!(await pathExists(entry.binaryPath))) return [];
  return profilesUnder(
    entry.userDataDir,
    entry.binaryPath,
    entry.name,
    entry.name,
  );
};

/** Uninstalled browsers are silently skipped — not an error. */
export const discoverProfiles = async (): Promise<DetectedProfile[]> => {
  const [builtIn, custom] = await Promise.all([
    Promise.all(BUILT_IN_BROWSERS.map(discoverBuiltIn)),
    readCustomBrowsers().then((entries) =>
      Promise.all(entries.map(discoverCustom)),
    ),
  ]);
  return [...builtIn.flat(), ...custom.flat()];
};

/**
 * Scan the persisted custom-browser registrations and report the ones
 * whose `binaryPath` and/or `userDataDir` are no longer on disk. Used
 * only by `sources list`; `discoverProfiles` deliberately drops these
 * because the capture pipeline can't use them.
 */
export const findBrokenCustomSources = async (): Promise<
  BrokenCustomSource[]
> => {
  const customs = await readCustomBrowsers();
  const results = await Promise.all(
    customs.map(async (entry): Promise<BrokenCustomSource | null> => {
      const [binaryOk, userDataDirOk] = await Promise.all([
        pathExists(entry.binaryPath),
        pathExists(entry.userDataDir),
      ]);
      if (binaryOk && userDataDirOk) return null;
      return {
        name: entry.name,
        binaryPath: entry.binaryPath,
        userDataDir: entry.userDataDir,
        missingBinary: !binaryOk,
        missingUserDataDir: !userDataDirOk,
      };
    }),
  );
  return results.filter((r): r is BrokenCustomSource => r !== null);
};

const matchesBrowser = (input: string, profile: DetectedProfile): boolean => {
  const lowered = input.trim().toLowerCase();
  return (
    profile.browserKey.toLowerCase() === lowered ||
    profile.browserDisplayName.toLowerCase() === lowered
  );
};

const matchesProfile = (input: string, profile: DetectedProfile): boolean => {
  const lowered = input.trim().toLowerCase();
  return (
    profile.profileDirName.toLowerCase() === lowered ||
    profile.profileDisplayName.toLowerCase() === lowered
  );
};

/** Pure resolver: no I/O, no platform branches — directly unit-testable. */
export const resolveProfileFromCandidates = (
  browserInput: string,
  profileInput: string,
  registeredBrowserKeys: { key: string; displayName: string }[],
  detected: DetectedProfile[],
): DetectedProfile => {
  const lowered = browserInput.trim().toLowerCase();
  const known = registeredBrowserKeys.some(
    (b) =>
      b.key.toLowerCase() === lowered ||
      b.displayName.toLowerCase() === lowered,
  );
  if (!known) {
    throw new UsageError(
      `Unknown browser "${terminalSafe(browserInput)}". Run \`browserless profile sources list\` to see detected browsers, or register a custom one with \`profile sources add\`.`,
      'unknown-browser',
    );
  }

  const matches = detected.filter(
    (p) => matchesBrowser(browserInput, p) && matchesProfile(profileInput, p),
  );

  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    const sameBrowser = detected.filter((p) => matchesBrowser(browserInput, p));
    if (sameBrowser.length === 0) {
      throw new UsageError(
        `Browser "${terminalSafe(browserInput)}" is registered but has no detected profiles on this machine.`,
        'browser-has-no-profiles',
      );
    }
    const candidates = sameBrowser
      .map(
        (p) =>
          `  - ${terminalSafe(p.profileDisplayName)} (${terminalSafe(p.profileDirName)})`,
      )
      .join('\n');
    throw new UsageError(
      `No profile named "${terminalSafe(profileInput)}" under ${terminalSafe(browserInput)}. Available profiles:\n${candidates}`,
      'local-profile-not-found',
    );
  }

  const candidates = matches
    .map(
      (p) =>
        `  - ${terminalSafe(p.profileDisplayName)} (dir: ${terminalSafe(p.profileDirName)}) under ${terminalSafe(p.browserDisplayName)}`,
    )
    .join('\n');
  throw new UsageError(
    `Profile "${terminalSafe(profileInput)}" matches multiple entries — disambiguate by passing the directory name to --profile:\n${candidates}`,
    'local-profile-ambiguous',
  );
};

/**
 * Resolve `--browser X --profile Y` to a single detected profile. Throws a
 * UsageError describing the candidates if zero or multiple match.
 */
export const resolveProfile = async (
  browserInput: string,
  profileInput: string,
): Promise<DetectedProfile> => {
  const customs = await readCustomBrowsers();
  const registeredKeys: { key: string; displayName: string }[] = [
    ...BUILT_IN_BROWSERS.map((b) => ({
      key: b.key,
      displayName: b.displayName,
    })),
    ...customs.map((c) => ({ key: c.name, displayName: c.name })),
  ];
  const detected = await discoverProfiles();
  return resolveProfileFromCandidates(
    browserInput,
    profileInput,
    registeredKeys,
    detected,
  );
};
