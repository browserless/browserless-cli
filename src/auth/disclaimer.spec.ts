import { expect } from 'chai';
import { DISCLAIMER_TEXT, ensureTermsAccepted } from './disclaimer.js';
import { readConfig, writeConfig } from '../config/store.js';
import { PreconditionError } from '../errors.js';
import { setupTempHome, TempHome } from '../test-helpers/temp-home.js';
import { captureAndClear } from '../test-helpers/env.js';

describe('auth/disclaimer.ensureTermsAccepted', () => {
  let home: TempHome;
  let restoreEnv: () => void;

  beforeEach(async () => {
    home = await setupTempHome();
    restoreEnv = captureAndClear(['CI', 'BROWSERLESS_ACCEPT_TERMS']);
    // force non-interactive path; tests assert against TTY-less behavior
    process.env.CI = 'true';
  });

  afterEach(async () => {
    restoreEnv();
    await home.cleanup();
  });

  it('skips silently when accepted within TTL', async () => {
    await writeConfig({
      accepted_terms_at: new Date().toISOString(),
      terms_ttl_days: 7,
    });
    await ensureTermsAccepted({ acceptViaFlag: false });
  });

  it('throws in non-interactive mode when no acceptance is recorded', async () => {
    let threw = false;
    try {
      await ensureTermsAccepted({ acceptViaFlag: false });
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(PreconditionError);
    }
    expect(threw).to.be.true;
  });

  it('bypasses prompt with --accept-terms', async () => {
    await ensureTermsAccepted({ acceptViaFlag: true });
    const config = await readConfig();
    expect(config.accepted_terms_at).to.be.a('string');
  });

  it('bypasses prompt with BROWSERLESS_ACCEPT_TERMS=1', async () => {
    process.env.BROWSERLESS_ACCEPT_TERMS = '1';
    await ensureTermsAccepted({ acceptViaFlag: false });
    const config = await readConfig();
    expect(config.accepted_terms_at).to.be.a('string');
  });

  it('re-prompts when acceptance is older than TTL', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await writeConfig({
      accepted_terms_at: tenDaysAgo.toISOString(),
      terms_ttl_days: 7,
    });
    let threw = false;
    try {
      await ensureTermsAccepted({ acceptViaFlag: false });
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(PreconditionError);
    }
    expect(threw).to.be.true;
  });

  it('re-prompts every run when TTL is 0', async () => {
    await writeConfig({
      accepted_terms_at: new Date().toISOString(),
      terms_ttl_days: 7,
    });
    let threw = false;
    try {
      await ensureTermsAccepted({ acceptViaFlag: false, ttlDaysOverride: 0 });
    } catch (err) {
      threw = true;
      expect(err).to.be.instanceOf(PreconditionError);
    }
    expect(threw).to.be.true;
  });

  it('honors --terms-ttl-days override', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await writeConfig({
      accepted_terms_at: twoHoursAgo.toISOString(),
      terms_ttl_days: 7,
    });
    // Override TTL to 1 day — within window, should skip
    await ensureTermsAccepted({ acceptViaFlag: false, ttlDaysOverride: 1 });
  });

  describe('interactive prompt (injected seam)', () => {
    // The production code uses Node's readline against the real TTY.
    // Tests inject a `prompt` function via the test-only second argument
    // so the accept-/decline-token paths can be exercised deterministically.
    // `isInteractive: true` bypasses the TTY+CI guards.
    it('accepts exactly "I accept" and persists the timestamp', async () => {
      let called = false;
      let promptedText = '';
      await ensureTermsAccepted(
        { acceptViaFlag: false },
        {
          isInteractive: true,
          prompt: async (text) => {
            called = true;
            promptedText = text;
            return 'I accept';
          },
        },
      );
      expect(called).to.be.true;
      // The prompt callback receives the full disclaimer body so a custom
      // UI could render it however it likes — verify a known sentinel
      // substring that survives line-wrapping.
      expect(promptedText).to.include('accept responsibility');
      expect(promptedText).to.include('contents of the upload');
      const config = await readConfig();
      expect(config.accepted_terms_at).to.be.a('string');
    });

    it('trims whitespace before comparing the token', async () => {
      await ensureTermsAccepted(
        { acceptViaFlag: false },
        { isInteractive: true, prompt: async () => '   I accept   \n' },
      );
      const config = await readConfig();
      expect(config.accepted_terms_at).to.be.a('string');
    });

    it('rejects any other answer — empty, almost-right, lowercase, "y"', async () => {
      for (const wrong of [
        '',
        'y',
        'yes',
        'i accept',
        'I Accept',
        'accept',
        'I accept.',
      ]) {
        let threw = false;
        try {
          await ensureTermsAccepted(
            { acceptViaFlag: false },
            { isInteractive: true, prompt: async () => wrong },
          );
        } catch (err) {
          threw = true;
          expect(err).to.be.instanceOf(PreconditionError);
        }
        expect(
          threw,
          `wrong answer ${JSON.stringify(wrong)} should have been rejected`,
        ).to.be.true;
        // Each rejection must NOT have written acceptance to config.
        const config = await readConfig();
        expect(
          config.accepted_terms_at,
          `accepted_terms_at should be unset after ${JSON.stringify(wrong)}`,
        ).to.be.undefined;
      }
    });
  });
});

describe('auth/disclaimer.DISCLAIMER_TEXT', () => {
  it('says how a domain excluded after the first upload reaches an existing profile', () => {
    // A flagless `profile refresh` replays the exclusions the profile was captured
    // with, so `profile exclude add` alone does not change an existing profile.
    expect(DISCLAIMER_TEXT).to.match(/profile refresh/);
    expect(DISCLAIMER_TEXT).to.match(/--exclude-domain/);
  });
});
