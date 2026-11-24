import fs from 'node:fs/promises';
import path from 'node:path';
import { home_ } from './paths.js';

/**
 * Linux Chromium reads its keyring backend either from a
 * `password-store=…` line in `Default/Preferences`, or falls back to
 * auto-detection at runtime. We mirror that: if `Preferences` pins one,
 * use it; otherwise fall through to `basic` so cookie decryption at least
 * doesn't crash. The CLI prints a warning when defaulting so the user
 * understands why decryption may fail and can override via
 * `--password-store=<store>` if they normally launch Chrome with one.
 */
export type PasswordStore =
  | 'basic'
  | 'gnome'
  | 'gnome-libsecret'
  | 'kwallet'
  | 'kwallet5'
  | 'detect';

const VALID_STORES: PasswordStore[] = [
  'basic',
  'gnome',
  'gnome-libsecret',
  'kwallet',
  'kwallet5',
  'detect',
];

export const isValidPasswordStore = (raw: string): raw is PasswordStore =>
  (VALID_STORES as string[]).includes(raw);

/**
 * Best-effort detection of the user's Chrome password store on Linux.
 * Returns `null` if we can't tell — the caller should fall back to
 * `basic` and warn.
 */
export const detectLinuxPasswordStore = async (
  userDataDir: string,
): Promise<PasswordStore | null> => {
  if (process.platform !== 'linux') return null;
  const prefs = path.join(userDataDir, 'Default', 'Preferences');
  try {
    const raw = await fs.readFile(prefs, 'utf-8');
    const parsed = JSON.parse(raw);
    const value = parsed?.profile?.password_manager?.encryption_backend ??
      parsed?.password_manager_enabled_pref;
    if (typeof value === 'string' && isValidPasswordStore(value)) {
      return value;
    }
  } catch {
    // fall through
  }

  const xdg = process.env.XDG_CURRENT_DESKTOP?.toLowerCase() ?? '';
  if (xdg.includes('kde')) return 'kwallet5';
  if (xdg.includes('gnome') || xdg.includes('unity')) return 'gnome-libsecret';

  return null;
};

/** Resolve --password-store to pass to the headless launch on Linux. */
export const resolveLinuxPasswordStore = async (
  userDataDir: string,
  override?: string,
): Promise<{ store: PasswordStore; defaulted: boolean }> => {
  if (override && isValidPasswordStore(override)) {
    return { store: override, defaulted: false };
  }
  const detected = await detectLinuxPasswordStore(userDataDir);
  if (detected) return { store: detected, defaulted: false };
  return { store: 'basic', defaulted: true };
};

// Suppress "unused" lint on home_ when the file is reduced to detect-only
// helpers in the future.
void home_;
