import path from 'node:path';
import {
  home_,
  winAppData,
  winLocalAppData,
  winProgramFiles,
  winProgramFilesX86,
} from './paths.js';

/**
 * Single registry entry — one (browser, OS) tuple.
 *
 * `key` is the short stable identifier surfaced to users via `--browser
 * <key>`. `displayName` is the user-visible name from `Local State` (e.g.
 * "Google Chrome"). Both forms are accepted, case-insensitively, by
 * `findBrowserByKeyOrName`.
 */
export interface BrowserRegistryEntry {
  key: string;
  displayName: string;
  /**
   * Where the browser stores its user-data-dir. A single string suffices
   * for browsers that always land in one place. Use a tuple when the same
   * browser installs at different locations via different packagers — e.g.
   * Chromium on Linux lives at `~/.config/chromium` from apt but at
   * `~/snap/chromium/common/chromium` when installed via Snap. Discovery
   * walks the list and picks the first existing dir.
   */
  userDataDirByPlatform: Partial<Record<NodeJS.Platform, string | string[]>>;
  binaryPathByPlatform: Partial<Record<NodeJS.Platform, string[]>>;
}

const home = home_();

/**
 * Built-in browser registry. Per-OS user-data-dir + binary path lookup. The
 * binary path is a list because some browsers ship at a few possible
 * locations (e.g. system vs. per-user installs on Windows) and we pick the
 * first one that exists at discovery time.
 */
export const BUILT_IN_BROWSERS: BrowserRegistryEntry[] = [
  {
    key: 'chrome',
    displayName: 'Google Chrome',
    userDataDirByPlatform: {
      darwin: path.join(home, 'Library/Application Support/Google/Chrome'),
      linux: path.join(home, '.config/google-chrome'),
      win32: path.join(winLocalAppData(), 'Google', 'Chrome', 'User Data'),
    },
    binaryPathByPlatform: {
      darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ],
      linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
      win32: [
        path.join(
          winProgramFiles(),
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
        path.join(
          winProgramFilesX86(),
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
        path.join(
          winLocalAppData(),
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
      ],
    },
  },
  {
    key: 'chrome-beta',
    displayName: 'Google Chrome Beta',
    userDataDirByPlatform: {
      darwin: path.join(home, 'Library/Application Support/Google/Chrome Beta'),
      linux: path.join(home, '.config/google-chrome-beta'),
      win32: path.join(winLocalAppData(), 'Google', 'Chrome Beta', 'User Data'),
    },
    binaryPathByPlatform: {
      darwin: [
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      ],
      linux: ['/usr/bin/google-chrome-beta'],
      win32: [
        path.join(
          winProgramFiles(),
          'Google',
          'Chrome Beta',
          'Application',
          'chrome.exe',
        ),
      ],
    },
  },
  {
    key: 'chrome-dev',
    displayName: 'Google Chrome Dev',
    userDataDirByPlatform: {
      darwin: path.join(home, 'Library/Application Support/Google/Chrome Dev'),
      linux: path.join(home, '.config/google-chrome-unstable'),
      win32: path.join(winLocalAppData(), 'Google', 'Chrome Dev', 'User Data'),
    },
    binaryPathByPlatform: {
      darwin: [
        '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      ],
      linux: ['/usr/bin/google-chrome-unstable'],
      win32: [
        path.join(
          winProgramFiles(),
          'Google',
          'Chrome Dev',
          'Application',
          'chrome.exe',
        ),
      ],
    },
  },
  {
    key: 'chrome-canary',
    displayName: 'Google Chrome Canary',
    userDataDirByPlatform: {
      darwin: path.join(
        home,
        'Library/Application Support/Google/Chrome Canary',
      ),
      win32: path.join(
        winLocalAppData(),
        'Google',
        'Chrome SxS',
        'User Data',
      ),
    },
    binaryPathByPlatform: {
      darwin: [
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ],
      win32: [
        path.join(
          winLocalAppData(),
          'Google',
          'Chrome SxS',
          'Application',
          'chrome.exe',
        ),
      ],
    },
  },
  {
    key: 'edge',
    displayName: 'Microsoft Edge',
    userDataDirByPlatform: {
      darwin: path.join(home, 'Library/Application Support/Microsoft Edge'),
      linux: path.join(home, '.config/microsoft-edge'),
      win32: path.join(winLocalAppData(), 'Microsoft', 'Edge', 'User Data'),
    },
    binaryPathByPlatform: {
      darwin: [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ],
      linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
      win32: [
        path.join(
          winProgramFilesX86(),
          'Microsoft',
          'Edge',
          'Application',
          'msedge.exe',
        ),
        path.join(
          winProgramFiles(),
          'Microsoft',
          'Edge',
          'Application',
          'msedge.exe',
        ),
      ],
    },
  },
  {
    key: 'brave',
    displayName: 'Brave',
    userDataDirByPlatform: {
      darwin: path.join(
        home,
        'Library/Application Support/BraveSoftware/Brave-Browser',
      ),
      linux: path.join(home, '.config/BraveSoftware/Brave-Browser'),
      win32: path.join(
        winLocalAppData(),
        'BraveSoftware',
        'Brave-Browser',
        'User Data',
      ),
    },
    binaryPathByPlatform: {
      darwin: [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ],
      linux: ['/usr/bin/brave-browser', '/usr/bin/brave'],
      win32: [
        path.join(
          winProgramFiles(),
          'BraveSoftware',
          'Brave-Browser',
          'Application',
          'brave.exe',
        ),
        path.join(
          winProgramFilesX86(),
          'BraveSoftware',
          'Brave-Browser',
          'Application',
          'brave.exe',
        ),
        // Per-user install (default for Brave's modern installer; what
        // `choco install brave` produces). Without this entry the CLI
        // can't see a Brave install that wasn't run as Administrator.
        path.join(
          winLocalAppData(),
          'BraveSoftware',
          'Brave-Browser',
          'Application',
          'brave.exe',
        ),
      ],
    },
  },
  {
    key: 'vivaldi',
    displayName: 'Vivaldi',
    userDataDirByPlatform: {
      darwin: path.join(home, 'Library/Application Support/Vivaldi'),
      linux: path.join(home, '.config/vivaldi'),
      win32: path.join(winLocalAppData(), 'Vivaldi', 'User Data'),
    },
    binaryPathByPlatform: {
      darwin: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'],
      linux: ['/usr/bin/vivaldi', '/usr/bin/vivaldi-stable'],
      win32: [
        path.join(
          winLocalAppData(),
          'Vivaldi',
          'Application',
          'vivaldi.exe',
        ),
      ],
    },
  },
  {
    key: 'opera',
    displayName: 'Opera',
    userDataDirByPlatform: {
      darwin: path.join(
        home,
        'Library/Application Support/com.operasoftware.Opera',
      ),
      linux: path.join(home, '.config/opera'),
      win32: path.join(winAppData(), 'Opera Software', 'Opera Stable'),
    },
    binaryPathByPlatform: {
      darwin: ['/Applications/Opera.app/Contents/MacOS/Opera'],
      linux: ['/usr/bin/opera'],
      win32: [
        path.join(
          winProgramFiles(),
          'Opera',
          'launcher.exe',
        ),
      ],
    },
  },
  {
    key: 'arc',
    displayName: 'Arc',
    userDataDirByPlatform: {
      darwin: path.join(home, 'Library/Application Support/Arc/User Data'),
    },
    binaryPathByPlatform: {
      darwin: ['/Applications/Arc.app/Contents/MacOS/Arc'],
    },
  },
  {
    // Plain Chromium (the upstream open-source build, not Google Chrome).
    // Real users on Arch / NixOS / privacy-focused distros run this; macOS
    // Homebrew also installs a Chromium.app for some testing setups.
    // Linux: both apt (`~/.config/chromium`) and Snap
    // (`~/snap/chromium/common/chromium`) — Snap confines apps to
    // `~/snap/<name>/...` so the conventional XDG path is empty for
    // Snap users. Listing both makes discovery work either way.
    key: 'chromium',
    displayName: 'Chromium',
    userDataDirByPlatform: {
      darwin: path.join(home, 'Library/Application Support/Chromium'),
      linux: [
        path.join(home, '.config/chromium'),
        path.join(home, 'snap/chromium/common/chromium'),
      ],
      win32: path.join(winLocalAppData(), 'Chromium', 'User Data'),
    },
    binaryPathByPlatform: {
      darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      linux: [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ],
      win32: [
        path.join(
          winProgramFiles(),
          'Chromium',
          'Application',
          'chrome.exe',
        ),
        path.join(
          winLocalAppData(),
          'Chromium',
          'Application',
          'chrome.exe',
        ),
      ],
    },
  },
];

const matches = (input: string, candidate: string): boolean =>
  input.trim().toLowerCase() === candidate.trim().toLowerCase();

/**
 * Resolve a `--browser` argument to its registry entry. Accepts the short
 * key (`chrome`) or the display name (`"Google Chrome"`), case-insensitive.
 */
export const findBuiltInByKeyOrName = (
  input: string,
): BrowserRegistryEntry | null =>
  BUILT_IN_BROWSERS.find(
    (b) => matches(input, b.key) || matches(input, b.displayName),
  ) ?? null;
