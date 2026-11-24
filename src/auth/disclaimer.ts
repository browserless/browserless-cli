import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readConfig, updateConfig } from '../config/store.js';
import { DEFAULT_TERMS_TTL_DAYS } from '../config/schema.js';
import { PreconditionError } from '../errors.js';

export const DISCLAIMER_TEXT = `
Heads up — uploading a profile sends authentication state to Browserless:

  • Cookies, localStorage and IndexedDB from the browser profile you select
    are read locally, encrypted, and uploaded to the Browserless server you
    are pointing at.
  • Only upload profiles you have authority to share. Cookies for banking,
    healthcare, employer-SSO or other sensitive sites should be added to the
    domain exclusion list (\`browserless profile exclude add <domain>\`).
  • Each cloud profile keeps the exclusion list it was captured with, and a
    later \`profile refresh\` reuses it. To apply a domain you excluded
    since, refresh with \`--exclude-domain <domain>\`: that replaces the
    stored list with this machine's list plus the domain.
  • Your local browser profile is never modified — the CLI runs against a
    temporary copy and cleans it up after capture.

By continuing you confirm you understand the above and accept responsibility
for the contents of the upload. Privacy policy: https://www.browserless.io/privacy-policy
`;

const ACCEPT_TOKEN = 'I accept';

export const isCi = (): boolean => !!process.env.CI;

const isWithinTtl = (
  acceptedAt: string | undefined,
  ttlDays: number,
): boolean => {
  if (!acceptedAt || ttlDays <= 0) return false;
  const ts = Date.parse(acceptedAt);
  if (!Number.isFinite(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs >= 0 && ageMs < ttlDays * 24 * 60 * 60 * 1000;
};

/**
 * Pluggable interactive prompt seam. Production code uses Node's readline
 * against stdin/stdout; tests inject a deterministic answer so the
 * interactive path can be exercised without a real TTY. The function is
 * given the disclaimer text up front and must return the user's typed
 * answer (already-trimmed is fine; the caller trims defensively).
 */
export type DisclaimerPrompt = (disclaimerText: string) => Promise<string>;

const defaultPrompt: DisclaimerPrompt = async (text) => {
  output.write(text);
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(`\nType "${ACCEPT_TOKEN}" to continue: `);
  } finally {
    rl.close();
  }
};

export interface DisclaimerOptions {
  /** Bypass the prompt (e.g. `--accept-terms` or `BROWSERLESS_ACCEPT_TERMS=1`). */
  acceptViaFlag: boolean;
  /** Override TTL — `--terms-ttl-days N` or `0` to re-prompt every run. */
  ttlDaysOverride?: number;
}

/**
 * Test-only seam parameter. Lives in its own type so production callers
 * physically can't pass a fake prompt or override TTY detection by
 * accident — only `disclaimer.spec.ts` constructs values here.
 */
export interface DisclaimerSeams {
  prompt?: DisclaimerPrompt;
  isInteractive?: boolean;
}

/**
 * Show the liability disclaimer when the stored acknowledgment is missing
 * or older than `ttlDays`. Persists the new acceptance time on success.
 *
 * Exits 3 (PreconditionError) if the user declines, or if we have to
 * prompt but stdin isn't a TTY (CI without `--accept-terms` /
 * BROWSERLESS_ACCEPT_TERMS=1).
 *
 * The optional `seams` parameter is reserved for the spec — production
 * call sites pass only the first argument.
 */
export const ensureTermsAccepted = async (
  options: DisclaimerOptions,
  seams: DisclaimerSeams = {},
): Promise<void> => {
  const config = await readConfig();
  const ttlDays =
    options.ttlDaysOverride ?? config.terms_ttl_days ?? DEFAULT_TERMS_TTL_DAYS;

  if (isWithinTtl(config.accepted_terms_at, ttlDays)) return;

  if (options.acceptViaFlag || process.env.BROWSERLESS_ACCEPT_TERMS === '1') {
    await updateConfig((c) => {
      c.accepted_terms_at = new Date().toISOString();
    });
    return;
  }

  const interactive = seams.isInteractive ?? (input.isTTY && !isCi());
  if (!interactive) {
    throw new PreconditionError(
      `Liability disclaimer must be acknowledged before uploading. Re-run with \`--accept-terms\` or set BROWSERLESS_ACCEPT_TERMS=1 in non-interactive environments.`,
      'terms-not-accepted',
    );
  }

  const prompt = seams.prompt ?? defaultPrompt;
  const answer = (await prompt(DISCLAIMER_TEXT)).trim();

  if (answer !== ACCEPT_TOKEN) {
    throw new PreconditionError(
      'Disclaimer not accepted — aborting.',
      'terms-not-accepted',
    );
  }

  await updateConfig((c) => {
    c.accepted_terms_at = new Date().toISOString();
  });
};
