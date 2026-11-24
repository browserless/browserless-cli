import { expect } from 'chai';
import {
  formatEndResult,
  hasLoginIntent,
  normalizeRationale,
  summarizeParams,
  unwrapToolCall,
  buildFirstTurn,
  LOGIN_TIP,
} from './agent-format.js';

// Tests run without a TTY → ANSI helpers no-op, so assertions can use plain text.

describe('cli-utils/agent-format', function () {
  describe('hasLoginIntent', function () {
    it('matches the common login phrasings', function () {
      expect(hasLoginIntent('please log into example.com')).to.equal(true);
      expect(hasLoginIntent('sign in to my account')).to.equal(true);
      expect(hasLoginIntent('authenticate against the API')).to.equal(true);
      expect(hasLoginIntent('sign-up for the newsletter')).to.equal(true);
    });

    it('does not match unrelated prompts', function () {
      expect(hasLoginIntent('summarize this article')).to.equal(false);
      expect(hasLoginIntent('take a screenshot of the homepage')).to.equal(
        false,
      );
      // "login" as a substring inside a non-word — still inside \b boundaries
      // for "login" but the prompt isn't asking for login action; the test
      // documents the conservative false-positive trade we accept.
      expect(hasLoginIntent('the login button is blue')).to.equal(true);
    });
  });

  describe('buildFirstTurn', function () {
    const header =
      'Instructions from the Browserless CLI (not typed by the user):';
    const otp =
      '- You may still ask the user for a one-time verification code that a site sends during sign-in.';

    it('wraps the raw task with the exact no-secrets instructions', function () {
      expect(buildFirstTurn('  summarize\nUSERNAME=x  ')).to.equal(
        [
          header,
          '- Never ask the user for a password, API key, or other secret, and never ask them to type one into this chat. If a site requires signing in, stop and say sign-in is needed; the user can save a signed-in browser with `browserless profile upload --name <name> --browser <browser> --profile <local-profile>` and rerun with `browserless agent --cloud-profile <name>`.',
          otp,
          '',
          'User task:',
          '  summarize\nUSERNAME=x  ',
        ].join('\n'),
      );
      expect(buildFirstTurn('hello')).to.not.match(
        /USERNAME=|PASSWORD=|pass "profile"/,
      );
    });

    it('uses the exact saved-profile instructions', function () {
      expect(buildFirstTurn('list my PRs', { cloudProfile: 'work' })).to.equal(
        [
          header,
          '- Open every new browser session with the user\'s saved cloud profile "work": pass "profile": "work" to browserless_agent whenever you start a session without a sessionId. Keep reusing that session\'s sessionId afterwards.',
          '- Never ask the user for a password, API key, or other secret, and never ask them to type one into this chat. If a site still asks you to sign in, stop and say the saved profile is not signed in there; the user can update it with `browserless profile refresh --name work`.',
          otp,
          '',
          'User task:',
          'list my PRs',
        ].join('\n'),
      );
    });

    it('JSON-quotes the profile name in tool instructions', function () {
      expect(buildFirstTurn('go', { cloudProfile: 'a"b' })).to.contain(
        'pass "profile": "a\\"b" to browserless_agent',
      );
    });

    for (const name of ['a"b', "it's", 'a&calc&b', 'x@y', '-x']) {
      it(`uses a placeholder refresh hint for ${JSON.stringify(name)}`, function () {
        const hint = buildFirstTurn('go', { cloudProfile: name })
          .split('\n')
          .find((line) => line.startsWith('- Never ask'))!;
        expect(hint).to.equal(
          '- Never ask the user for a password, API key, or other secret, and never ask them to type one into this chat. If a site still asks you to sign in, stop and say the saved profile is not signed in there; the user can update it with `browserless profile refresh --name <name>`, quoting the profile name for their shell.',
        );
        expect(hint).to.not.contain(name);
      });
    }

    it('leaves conservative shell-safe profile names unchanged in the refresh hint', function () {
      expect(buildFirstTurn('go', { cloudProfile: 'AZaz09._-' })).to.contain(
        '`browserless profile refresh --name AZaz09._-`',
      );
    });

    it('points the login tip at upload and the agent flag', function () {
      expect(LOGIN_TIP).to.contain(
        'browserless profile upload --name <name> --browser <browser> --profile <local-profile>',
      );
      expect(LOGIN_TIP).to.contain('--cloud-profile <name>');
    });
  });

  describe('summarizeParams', function () {
    it('renders key=value pairs trimmed to the cap', function () {
      const out = summarizeParams({ url: 'https://example.com' }, 60);
      expect(out).to.contain('url=https://example.com');
    });

    it('summarizes a commands batch by method list', function () {
      const out = summarizeParams(
        { commands: [{ method: 'type' }, { method: 'click' }] },
        60,
      );
      expect(out).to.equal('2 cmds: type → click');
    });

    it('does not split emoji when truncating parameter values or command summaries', function () {
      expect(summarizeParams({ url: 'a'.repeat(28) + '😀bc' })).to.equal(
        `url=${'a'.repeat(28)}😀…`,
      );
      expect(
        summarizeParams(
          { commands: [{ method: 'a'.repeat(17) + '😀bc' }] },
          26,
        ),
      ).to.equal(`1 cmds: ${'a'.repeat(17)}😀`);
    });

    it('returns empty for non-objects', function () {
      expect(summarizeParams(undefined)).to.equal('');
      expect(summarizeParams('x')).to.equal('');
    });

    it('redacts sensitive values (typed text / named secrets) but not benign keys', function () {
      const out = summarizeParams(
        { selector: '#pw', text: 'hunter2', token: 'abc123' },
        120,
      );
      expect(out).to.contain('selector=#pw');
      expect(out).to.contain('text=[REDACTED]');
      expect(out).to.contain('token=[REDACTED]');
      expect(out).to.not.contain('hunter2');
      expect(out).to.not.contain('abc123');
    });

    it('does not redact dual-use keys like code / key', function () {
      const out = summarizeParams({ code: 'return 1', key: 'Enter' }, 120);
      expect(out).to.contain('code=return 1');
      expect(out).to.contain('key=Enter');
    });
  });

  describe('unwrapToolCall', function () {
    it('unwraps a single browserless_agent call to its inner method + params', function () {
      const out = unwrapToolCall('browserless_agent', {
        method: 'goto',
        params: { url: 'https://x' },
        rationale: 'Navigating',
      });
      expect(out.method).to.equal('goto');
      expect(out.params).to.deep.equal({ url: 'https://x' });
    });

    it('unwraps a batch to the commands list (so summarizeParams shows N cmds)', function () {
      const out = unwrapToolCall('browserless_agent', {
        commands: [{ method: 'type' }, { method: 'click' }],
      });
      expect(out.method).to.equal('commands');
      expect(summarizeParams(out.params)).to.equal('2 cmds: type → click');
    });

    it('maps browserless_skill to skill + {id}', function () {
      const out = unwrapToolCall('browserless_skill', {
        id: 'autonomous-login',
      });
      expect(out.method).to.equal('skill');
      expect(out.params).to.deep.equal({ id: 'autonomous-login' });
    });

    it('falls back to agent when method is absent', function () {
      expect(unwrapToolCall('browserless_agent', {}).method).to.equal('agent');
    });

    it('passes through an unknown tool name untouched', function () {
      const params = { foo: 1 };
      const out = unwrapToolCall('something_else', params);
      expect(out.method).to.equal('something_else');
      expect(out.params).to.equal(params);
    });
  });

  describe('normalizeRationale', function () {
    it('returns undefined for blank or missing input', function () {
      expect(normalizeRationale(undefined)).to.equal(undefined);
      expect(normalizeRationale('')).to.equal(undefined);
      expect(normalizeRationale('   ')).to.equal(undefined);
    });

    it('trims surrounding whitespace', function () {
      expect(normalizeRationale('  Navigating to login  ')).to.equal(
        'Navigating to login',
      );
    });

    it("does not truncate long rationale — length is the model's concern", function () {
      const long =
        'Filling out a very detailed multi-field signup form for a brand-new account';
      expect(normalizeRationale(long)).to.equal(long);
    });
  });

  describe('formatEndResult', function () {
    it('returns empty when no structured result is present', function () {
      expect(formatEndResult({ result: null })).to.equal('');
    });

    it('renders the success + reason_code + final_url block', function () {
      const out = formatEndResult({
        result: {
          success: true,
          reason_code: 'logged_in',
          final_url: 'https://x/home',
        },
      });
      expect(out).to.contain('success');
      expect(out).to.contain('reason_code: logged_in');
      expect(out).to.contain('final_url: https://x/home');
    });

    it('renders "failed" when success is false', function () {
      expect(formatEndResult({ result: { success: false } })).to.contain(
        'failed',
      );
    });

    it('returns empty for a malformed result (missing boolean success)', function () {
      // Wire shape drifted / partial frame — the runtime guard rejects it
      // rather than rendering a misleading "failed" block.
      const malformed = { reason_code: 'x' } as unknown as {
        success: boolean;
      };
      expect(formatEndResult({ result: malformed })).to.equal('');
    });
  });
});
