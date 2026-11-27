import { expect } from 'chai';
import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Sinon from 'sinon';
import {
  addCaptureFlags,
  buildCaptureSettings,
  captureIsInteractive,
  createProgressRenderer,
  CaptureFlags,
  mergeStoredSettings,
  printEffectiveSettings,
  runCapture,
  warnUnusableExcludes,
  SETTINGS_REPLAY_SOURCE,
  validateOnlyDomain,
} from './capture-runner.js';
import { version } from '../version.js';
import { setupTempHome } from '../test-helpers/temp-home.js';

describe('cli-utils/capture-runner progress and interactivity', () => {
  it('waits only when stdin is a TTY and CI is absent', () => {
    expect(captureIsInteractive(true, false)).to.equal(true);
    expect(captureIsInteractive(true, true)).to.equal(false);
    expect(captureIsInteractive(false, false)).to.equal(false);
    expect(captureIsInteractive(undefined, false)).to.equal(false);
  });

  it('renders unlock guidance once in order without changing existing phase output', () => {
    const lines: string[] = [];
    const render = createProgressRenderer(
      {
        browserDisplayName: 'Google Chrome',
        profileDisplayName: 'Personal',
        binaryPath: 'C:\\Chrome\\chrome.exe',
      },
      (line) => lines.push(line),
    );
    render({ phase: 'copying' });
    render({ phase: 'copying' });
    render({
      phase: 'waiting-for-unlock',
      relativePath: 'Default\\Network\\Cookies',
      browserRunning: true,
      code: 'EBUSY',
    });
    render({ phase: 'capturing-origins', attempted: 0, total: 8, origin: '' });
    render({ phase: 'done' });
    expect(lines).to.deep.equal([
      'copying profile data…',
      'Google Chrome is still running, so Windows keeps Default\\Network\\Cookies locked.',
      'Quit Google Chrome completely now (menu → Exit, or right-click its icon in the taskbar notification area → Exit). The capture continues automatically once it has closed — waiting up to 2 minutes (Ctrl+C to cancel).',
      'capturing per-origin storage…',
    ]);
  });

  it('says when it restarts a silent browser, then waits for the new one', () => {
    const lines: string[] = [];
    const render = createProgressRenderer(
      {
        browserDisplayName: 'Microsoft Edge',
        profileDisplayName: 'Default',
        binaryPath: '/usr/bin/microsoft-edge',
      },
      (line) => lines.push(line),
    );
    render({ phase: 'launching' });
    render({ phase: 'waiting-for-debugger' });
    render({ phase: 'restarting-browser' });
    render({ phase: 'launching' });
    render({ phase: 'waiting-for-debugger' });
    expect(lines).to.deep.equal([
      'launching headless browser…',
      'waiting for browser to be ready…',
      'browser did not respond in 10s; restarting it…',
      'launching headless browser…',
      'waiting for browser to be ready…',
    ]);
  });
});

/**
 * Every case below is verb-agnostic except the over-cap ones: the verb only
 * changes which consequence the warning describes.
 */
const build = (
  flags: Parameters<typeof buildCaptureSettings>[0],
  diagnostics: Parameters<typeof buildCaptureSettings>[1],
  verb: Parameters<typeof buildCaptureSettings>[2] = 'upload',
) => buildCaptureSettings(flags, diagnostics, verb);
import { UsageError } from '../errors.js';

/**
 * Regression tests for the Commander camelCase footgun. `--no-default-excludes`
 * is camelCased into `defaultExcludes` (NOT `noDefaultExcludes`) — reading
 * the wrong key silently disabled the persistent-list bypass for several
 * days before live testing caught it. These tests pin the wiring so the
 * bug can't reappear.
 */
describe('cli-utils/capture-runner.addCaptureFlags', () => {
  const parseWith = (extraArgs: string[]): Record<string, unknown> => {
    let captured: Record<string, unknown> | null = null;
    const program = new Command();
    program.exitOverride();
    const cmd = program.command('test');
    addCaptureFlags(cmd).action((opts) => {
      captured = opts;
    });
    program.parse([
      'node',
      'test',
      'test',
      '--browser',
      'chrome',
      '--profile',
      'Default',
      ...extraArgs,
    ]);
    if (!captured) throw new Error('action handler did not run');
    return captured;
  };

  it('without --no-default-excludes: defaultExcludes is true (the persistent list applies)', () => {
    const opts = parseWith([]);
    expect(opts.defaultExcludes).to.equal(true);
  });

  it('with --no-default-excludes: defaultExcludes is false (persistent list bypassed)', () => {
    const opts = parseWith(['--no-default-excludes']);
    expect(opts.defaultExcludes).to.equal(false);
  });

  it('Commander does NOT populate opts.noDefaultExcludes — regression for the silent-skip bug', () => {
    // The original code read `flags.noDefaultExcludes` which was always
    // undefined (Commander camelCases `--no-X` into `X`, not `noX`). The
    // bug was only caught by live-testing when the diagnostic showed
    // persistent excludes applied despite the flag.
    const opts = parseWith(['--no-default-excludes']);
    expect(opts.noDefaultExcludes).to.be.undefined;
  });

  it('--exclude-domain is repeatable and accumulates', () => {
    const opts = parseWith([
      '--exclude-domain',
      'a.com',
      '--exclude-domain',
      'b.com',
    ]);
    expect(opts.excludeDomain).to.deep.equal(['a.com', 'b.com']);
  });

  it('--accept-terms maps to acceptTerms: true', () => {
    const opts = parseWith(['--accept-terms']);
    expect(opts.acceptTerms).to.equal(true);
  });

  it('--terms-ttl-days <n> maps to termsTtlDays as a string', () => {
    const opts = parseWith(['--terms-ttl-days', '14']);
    expect(opts.termsTtlDays).to.equal('14');
  });

  describe('sourceOptional', () => {
    const parseBare = (opts: Parameters<typeof addCaptureFlags>[1]) => {
      let captured: Record<string, unknown> | null = null;
      const program = new Command();
      program.exitOverride();
      const cmd = program.command('test');
      addCaptureFlags(cmd, opts).action((parsed) => {
        captured = parsed;
      });
      program.parse(['node', 'test', 'test']);
      return captured as Record<string, unknown> | null;
    };

    it('true: --browser / --profile may be omitted and come back undefined', () => {
      const opts = parseBare({ sourceOptional: true });
      expect(opts?.browser).to.be.undefined;
      expect(opts?.profile).to.be.undefined;
    });

    it('default: source flags may be omitted for the picker', () => {
      const opts = parseBare(undefined);
      expect(opts).not.to.be.null;
      expect(opts?.browser).to.be.undefined;
      expect(opts?.profile).to.be.undefined;
    });

    // Commander re-wraps option descriptions, so compare on collapsed whitespace.
    const helpText = (opts?: Parameters<typeof addCaptureFlags>[1]) =>
      addCaptureFlags(new Command('test'), opts)
        .helpInformation()
        .replace(/\s+/g, ' ');

    it('true: the help text says where the source comes from instead', () => {
      expect(helpText({ sourceOptional: true })).to.contain(
        "read from the profile's stored settings when omitted",
      );
    });

    it('default: the help text carries no such promise', () => {
      expect(helpText()).to.not.contain('stored settings');
      expect(helpText()).to.contain(
        'Optional in a terminal: leave it out to choose from the browsers found on this machine',
      );
    });
  });
});

/**
 * `runCapture` calls this for every verb, so `upload` — the verb that CREATES the stored
 * list — warns too. It lived in `mergeStoredSettings` first, which only `refresh` calls
 * and only past an early `return flags`, so both other verbs were silent.
 */
describe('cli-utils/capture-runner.warnUnusableExcludes', () => {
  let stderr: Sinon.SinonStub;
  beforeEach(() => {
    stderr = Sinon.stub(process.stderr, 'write').returns(true);
  });
  afterEach(() => {
    Sinon.restore();
  });
  const out = (): string =>
    stderr
      .getCalls()
      .map((c) => String(c.args[0]))
      .join('');

  it('names each unusable entry and leaves the usable ones alone', () => {
    warnUnusableExcludes(['', 'okta.com', '*.']);
    expect(out()).to.match(
      /! --exclude-domain "" is not a usable domain pattern/,
    );
    expect(out()).to.match(/! --exclude-domain "\*\." is not a usable/);
    expect(out()).to.not.match(/okta\.com is not a usable/);
  });

  it('says nothing for an all-usable list', () => {
    warnUnusableExcludes(['okta.com']);
    expect(out()).to.equal('');
  });

  it('uses visible control notation for unusable patterns', () => {
    warnUnusableExcludes(['\n\t']);
    expect(out()).to.include('"\\u000a\\u0009"');
  });

  it('says nothing when the flag was never passed', () => {
    warnUnusableExcludes(undefined);
    expect(out()).to.equal('');
  });
});

describe('cli-utils/capture-runner.validateOnlyDomain', () => {
  it('no-ops on an empty list', () => {
    expect(() => validateOnlyDomain([])).not.to.throw();
  });

  it('no-ops when every pattern is valid', () => {
    expect(() =>
      validateOnlyDomain(['imdb.com', '*.example.com']),
    ).not.to.throw();
  });

  it('no-ops when at least one pattern is valid (rest silently dropped downstream)', () => {
    // Mixed input is tolerated — the invalid entries are no-ops once
    // normalization runs in the matchers; only the all-invalid case
    // would silently capture zero origins.
    expect(() => validateOnlyDomain(['imdb.com', '.'])).not.to.throw();
  });

  it('throws UsageError when every pattern normalizes to null', () => {
    // Each of these normalizes to null: '.' becomes empty after the
    // leading-dot strip; '*.' likewise; ' ' is whitespace-only.
    try {
      validateOnlyDomain(['.', '*.', '   ']);
      expect.fail('expected validateOnlyDomain to throw');
    } catch (err) {
      expect(err).to.be.instanceOf(UsageError);
      expect((err as UsageError).code).to.equal('invalid-only-domain');
      expect((err as Error).message).to.match(/--only-domain/);
      expect((err as Error).message).to.match(/no valid domain pattern/);
    }
  });
});

/**
 * `excludeDomains` must carry the EFFECTIVE merged list, not `flags.excludeDomain`.
 * Storing the raw flags would make a flagless `profile refresh` filter differently on a
 * machine whose `excluded_domains` config differs — which is the whole reason
 * `mergeStoredSettings` suppresses the local config when replaying a stored list.
 */
describe('cli-utils/capture-runner.buildCaptureSettings', () => {
  const base = { browser: 'chrome', profile: 'Default' };

  it('stores the merged exclusion list, not the raw --exclude-domain flags', () => {
    // The two lists differ on purpose: an implementation reading
    // `flags.excludeDomain` cannot pass this.
    const settings = build(
      { ...base, excludeDomain: ['flag.com'] },
      { excludedDomains: ['config.com', 'flag.com'] },
    );
    expect(settings?.excludeDomains).to.deep.equal(['config.com', 'flag.com']);
  });

  it('stores only the flag list when --no-default-excludes bypassed the config', () => {
    const settings = build(
      { ...base, excludeDomain: ['flag.com'], defaultExcludes: false },
      { excludedDomains: ['flag.com'] },
    );
    expect(settings?.excludeDomains).to.deep.equal(['flag.com']);
  });

  /**
   * An opt-out whose whole list normalizes away excluded nothing on purpose only if the
   * user asked for nothing. Here they asked for something unusable, so `[]` must NOT be
   * stored: storing it pins the profile to "exclude nothing" for good and every later
   * flagless refresh stops applying the machine's config. Distinct from a
   * genuinely empty input, which does store `[]`.
   */
  it('stores nothing when an opted-out list normalizes entirely away', () => {
    const settings = build(
      { ...base, excludeDomain: ['', '  '], defaultExcludes: false },
      { excludedDomains: ['', '  '] },
    );
    expect(settings).to.not.have.property('excludeDomains');
  });

  it('omits unset keys rather than emitting empties', () => {
    expect(build(base, { excludedDomains: [] })).to.deep.equal({
      browser: 'chrome',
      profile: 'Default',
      cliVersion: version,
    });
  });

  /**
   * `excludeDomains: []` records "captured with no exclusions", which a flagless
   * refresh replays instead of re-deriving from its own config — so it is stored ONLY
   * when the user actually opted out. `excluded_domains` has no default, so an empty
   * effective list is the normal state for a first upload; storing `[]` for that would
   * make a later refresh suppress a config the user added in the meantime.
   */
  it('stores an empty exclusion list only when the user opted out', () => {
    expect(
      build({ ...base, defaultExcludes: false }, { excludedDomains: [] }),
    ).to.deep.equal({
      browser: 'chrome',
      profile: 'Default',
      excludeDomains: [],
      cliVersion: version,
    });
  });

  it('leaves the key absent when the list is empty because nothing was configured', () => {
    const settings = build(
      { ...base, defaultExcludes: true },
      { excludedDomains: [] },
    );
    expect(settings).to.not.have.property('excludeDomains');
  });

  it('carries every set flag through, and always stamps cliVersion', () => {
    const settings = build(
      {
        browser: 'cli-capture-chrome',
        profile: 'Profile 1',
        onlyDomain: ['mail.google.com'],
        keepDomain: ['github.com'],
        autoFit: true,
        passwordStore: 'gnome-libsecret',
      },
      { excludedDomains: ['chase.com'] },
    );
    expect(settings).to.deep.equal({
      browser: 'cli-capture-chrome',
      profile: 'Profile 1',
      excludeDomains: ['chase.com'],
      onlyDomains: ['mail.google.com'],
      keepDomains: ['github.com'],
      autoFit: true,
      passwordStore: 'gnome-libsecret',
      cliVersion: version,
    });
  });

  it('omits autoFit when the flag is absent or false (server default is off)', () => {
    expect(
      build({ autoFit: false }, { excludedDomains: [] }),
    ).to.not.have.property('autoFit');
    expect(build({}, { excludedDomains: [] })).to.not.have.property('autoFit');
  });

  it('preserves filters without storing a partial source for an unsavable browser key', () => {
    for (const browser of ['Work!', 'Work ']) {
      const settings = buildCaptureSettings(
        { onlyDomain: ['example.com'] },
        { excludedDomains: [] },
        'upload',
        { browser, profile: 'Default' },
      );
      expect(settings).to.deep.equal({
        onlyDomains: ['example.com'],
        cliVersion: version,
      });
    }
  });

  /**
   * The server accepts only bare hostname patterns, but `normalizeExclusion`
   * deliberately accepts URL and non-ASCII spellings as *input*. Storing them raw
   * made the server 400 the whole upload after the capture had already run.
   */
  describe('normalization to what the server accepts', () => {
    it('reduces URL-form patterns to their hostname', () => {
      const settings = build(base, {
        excludedDomains: ['https://chase.com/login'],
      });
      expect(settings?.excludeDomains).to.deep.equal(['chase.com']);
    });

    it('punycodes non-ASCII hostnames and strips wildcard prefixes', () => {
      const settings = build(
        { ...base, onlyDomain: ['例え.jp'], keepDomain: ['*.EXAMPLE.com'] },
        { excludedDomains: [] },
      );
      expect(settings?.onlyDomains).to.deep.equal(['xn--r8jz45g.jp']);
      expect(settings?.keepDomains).to.deep.equal(['example.com']);
    });

    it('dedupes patterns that normalize to the same host', () => {
      const settings = build(base, {
        excludedDomains: [
          'example.com',
          '*.example.com',
          'https://example.com/x',
        ],
      });
      expect(settings?.excludeDomains).to.deep.equal(['example.com']);
    });

    // Distinct from an empty input, which IS stored: entries were supplied, so the
    // caller meant to exclude something and the stored value must be left alone.
    it('drops entries that normalize to nothing', () => {
      expect(
        build(base, { excludedDomains: ['   ', ''] }),
      ).to.not.have.property('excludeDomains');
    });

    it('bounds each list to the server cap', () => {
      const many = Array.from({ length: 150 }, (_, i) => `d${i}.com`);
      const settings = build(base, { excludedDomains: many });
      expect(settings?.excludeDomains).to.have.length(100);
    });
  });

  /**
   * The server rejects rather than truncates, and only after the capture has run,
   * so every one of its caps has to be mirrored here.
   */
  describe("the server's other caps", () => {
    it('drops a scalar that is only whitespace', () => {
      expect(
        build({ ...base, passwordStore: '   ' }, { excludedDomains: [] }),
      ).to.not.have.property('passwordStore');
    });

    it('drops a scalar past the 255-character field cap', () => {
      expect(
        build(
          { ...base, passwordStore: 'a'.repeat(256) },
          { excludedDomains: [] },
        ),
      ).to.not.have.property('passwordStore');
    });

    it('drops a domain past the 253-character cap', () => {
      expect(
        build(base, {
          excludedDomains: [`${'a'.repeat(250)}.com`, 'ok.com'],
        })?.excludeDomains,
      ).to.deep.equal(['ok.com']);
    });

    // normalizeExclusion keeps the raw string when the URL parser rejects it, so
    // these survive it and would fail the server's domain pattern.
    it("drops entries the server's domain pattern would reject", () => {
      expect(
        build(base, {
          excludedDomains: ['[::1]', 'a b.com', 'good.com'],
        })?.excludeDomains,
      ).to.deep.equal(['good.com']);
    });

    // A filter-less object would present the profile as captured with no filters, so
    // the next flagless refresh would replay "no exclusions" and capture more than this
    // run did — so store nothing instead.
    it('stores nothing at all rather than exceed the 8 KiB column cap', () => {
      const long = (i: number) =>
        `${Array.from({ length: 11 }, () => 'd'.repeat(19)).join('.')}-${i}.com`;
      const settings = build(
        {
          ...base,
          onlyDomain: Array.from({ length: 100 }, (_, i) => long(i)),
          keepDomain: Array.from({ length: 100 }, (_, i) => long(i + 200)),
        },
        {
          excludedDomains: Array.from({ length: 100 }, (_, i) => long(i + 400)),
        },
      );
      expect(settings).to.equal(undefined);
    });
  });

  /**
   * A real Chrome profile can be called `Bob's $tuff`, and the server rejects `$` in
   * scalar members. Dropping the metadata member is right; failing the upload over it
   * is not.
   */
  describe('shell-unsafe scalars', () => {
    ['$', '`', '\\', '!', '\u0000', '\u001f', '\u007f'].forEach((char) => {
      it(`drops a browser containing ${JSON.stringify(char)} instead of sending it`, () => {
        const settings = build(
          { browser: `chrome${char}`, profile: 'Default' },
          { excludedDomains: [] },
        );
        expect(settings).to.not.have.property('browser');
        expect(settings?.profile).to.equal('Default');
      });
    });

    it('keeps a legitimate display name with spaces and parentheses', () => {
      const settings = build(
        { browser: 'chrome', profile: 'Profile (work)' },
        { excludedDomains: [] },
      );
      expect(settings?.profile).to.equal('Profile (work)');
    });
  });
});

/**
 * The stderr warning is the whole justification for dropping metadata locally, and the
 * truncation case is a privacy control: a refresh replays the stored list in place of
 * the local config. Without coverage, deleting `warnDropped` would keep every other
 * spec green while a user's exclusion list silently truncated.
 */
describe('cli-utils/capture-runner.buildCaptureSettings warnings', () => {
  const base = { browser: 'chrome', profile: 'Default' };
  let stderr: Sinon.SinonStub;

  beforeEach(() => {
    stderr = Sinon.stub(process.stderr, 'write').returns(true);
  });
  afterEach(() => {
    Sinon.restore();
  });

  const warnings = (): string =>
    stderr
      .getCalls()
      .map((call) => String(call.args[0]))
      .join('\n');

  it('warns when a shell-unsafe scalar is dropped, naming the flag', () => {
    build({ ...base, profile: 'Bob$tuff' }, { excludedDomains: [] });
    expect(warnings()).to.match(/--profile/);
    expect(warnings()).to.match(/shell would interpret/i);
  });

  it('warns when an over-long scalar is dropped', () => {
    build({ ...base, passwordStore: 'a'.repeat(256) }, { excludedDomains: [] });
    expect(warnings()).to.match(/--password-store/);
    expect(warnings()).to.match(/255 characters/);
  });

  // `[::1]` normalizes to itself and IS honored by the capture, but the server only
  // stores plain hostname patterns — so this drop changes what a replay excludes.
  it('warns when a domain pattern the capture honored is dropped', () => {
    const settings = build(base, {
      excludedDomains: ['[::1]', 'chase.com'],
    });
    expect(settings?.excludeDomains).to.deep.equal(['chase.com']);
    expect(warnings()).to.match(/1 of 2 --exclude-domain patterns/);
    expect(warnings()).to.match(/plain hostname patterns/);
  });

  // The load-bearing one: a refresh replays the stored list in place of the local
  // config, so a truncated list means the replay captures domains this run
  // deliberately excluded.
  it('warns how many exclusion patterns were truncated', () => {
    build(base, {
      excludedDomains: Array.from({ length: 150 }, (_, i) => `d${i}.com`),
    });
    expect(warnings()).to.match(/50 of 150/);
    expect(warnings()).to.match(/--exclude-domain/);
  });

  const overCap = (verb: 'upload' | 'refresh') => {
    const long = (i: number) =>
      `${Array.from({ length: 11 }, () => 'd'.repeat(19)).join('.')}-${i}.com`;
    return build(
      {
        ...base,
        onlyDomain: Array.from({ length: 100 }, (_, i) => long(i)),
        keepDomain: Array.from({ length: 100 }, (_, i) => long(i + 200)),
      },
      { excludedDomains: Array.from({ length: 100 }, (_, i) => long(i + 400)) },
      verb,
    );
  };

  it('warns that nothing is stored when upload exceeds the column cap', () => {
    expect(overCap('upload')).to.equal(undefined);
    expect(warnings()).to.match(/Not storing any capture settings/);
    expect(warnings()).to.match(/8192-byte/);
    expect(warnings()).to.match(/nothing to replay/);
  });

  /**
   * An omitted key means "leave the stored settings alone" on refresh, so whatever
   * was there survives. Claiming it was dropped would send the user looking for a
   * problem in the wrong place.
   */
  it('warns that refresh left the previous settings in place, not that it stored none', () => {
    expect(overCap('refresh')).to.equal(undefined);
    expect(warnings()).to.match(/left as it was/);
    expect(warnings()).to.match(/will not reflect these filters/);
    expect(warnings()).to.not.match(/nothing to replay/);
  });

  it('says nothing when every member is stored as-is', () => {
    build(base, { excludedDomains: ['chase.com'] });
    expect(warnings()).to.equal('');
  });
});

/**
 * Everything `buildCaptureSettings` emits must already satisfy the server, or an
 * upload 400s *after* a real capture. The rules below are re-declared rather
 * than imported (separate repos), so this catches the CLI drifting — not the
 * server tightening. Keep them in step with AGENTS.md "Mirrored caps".
 */
describe('cli-utils/capture-runner.buildCaptureSettings server contract', () => {
  const SERVER_DOMAIN_PATTERN = /^[A-Za-z0-9*._-]+$/;
  const SERVER_DOMAIN_LENGTH = 253;
  const SERVER_FIELD_LENGTH = 255;
  const SERVER_BYTES = 8 * 1024;

  const hostile = [
    'foo bar.com',
    '[::1]',
    'a;b.com',
    '$(id).com',
    'https://chase.com/login',
    '例え.jp',
    '*.EXAMPLE.com',
    'ex%20ample.com',
    'list,two.com',
    "o'reilly.com",
    `${'a'.repeat(300)}.com`,
    '   ',
    '',
  ];

  it('never emits a value the server would reject', () => {
    const settings = build(
      {
        browser: '   ',
        profile: 'a'.repeat(256),
        onlyDomain: hostile,
        keepDomain: hostile,
        passwordStore: 'basic!',
      },
      { excludedDomains: hostile },
    );
    // Throw rather than return early: a fixture edit pushing this past the 8 KB cap
    // would otherwise make the whole cross-repo contract check silently vacuous.
    if (settings === undefined) {
      throw new Error(
        'fixture exceeded the settings byte cap — this contract check would be vacuous',
      );
    }

    (['excludeDomains', 'onlyDomains', 'keepDomains'] as const).forEach(
      (key) => {
        (settings[key] ?? []).forEach((domain) => {
          expect(domain, `${key} entry "${domain}"`).to.match(
            SERVER_DOMAIN_PATTERN,
          );
          expect(domain.length).to.be.at.most(SERVER_DOMAIN_LENGTH);
        });
        expect((settings[key] ?? []).length).to.be.at.most(100);
      },
    );

    (['browser', 'profile', 'passwordStore', 'cliVersion'] as const).forEach(
      (key) => {
        const value = settings[key];
        if (value === undefined) return;
        expect(value.trim(), `${key} must not be blank`).to.not.equal('');
        expect(value.length).to.be.at.most(SERVER_FIELD_LENGTH);
      },
    );

    expect(Buffer.byteLength(JSON.stringify(settings), 'utf8')).to.be.at.most(
      SERVER_BYTES,
    );
  });
});

/**
 * A refresh replays what the profile was captured with, so this merge is the only
 * place the replay rule lives.
 */
describe('cli-utils/capture-runner.mergeStoredSettings', () => {
  const stored = {
    browser: 'chrome',
    profile: 'Default',
    excludeDomains: ['chase.com'],
    onlyDomains: ['mail.google.com'],
    keepDomains: ['github.com'],
    autoFit: true,
    passwordStore: 'gnome-libsecret',
    cliVersion: '0.2.0',
  };

  it('returns the flags untouched when the profile has no stored settings', () => {
    const flags = { browser: 'brave', profile: 'Personal' };
    expect(mergeStoredSettings(flags, null)).to.deep.equal(flags);
    expect(mergeStoredSettings(flags, undefined)).to.deep.equal(flags);
  });

  it('falls back to stored values for every absent flag', () => {
    const merged = mergeStoredSettings({ defaultExcludes: true }, stored);
    expect(merged.browser).to.equal('chrome');
    expect(merged.profile).to.equal('Default');
    expect(merged.passwordStore).to.equal('gnome-libsecret');
    expect(merged.excludeDomain).to.deep.equal(['chase.com']);
    expect(merged.onlyDomain).to.deep.equal(['mail.google.com']);
    expect(merged.keepDomain).to.deep.equal(['github.com']);
    expect(merged.autoFit).to.equal(true);
  });

  it('lets an explicit flag win over the stored value', () => {
    const merged = mergeStoredSettings(
      { browser: 'brave', profile: 'Work', defaultExcludes: true },
      stored,
    );
    expect(merged.browser).to.equal('brave');
    expect(merged.profile).to.equal('Work');
  });

  // Appending would make it impossible to narrow a stored list, only to grow it.
  it('replaces a stored list wholesale rather than appending', () => {
    const merged = mergeStoredSettings(
      { onlyDomain: ['drive.google.com'], defaultExcludes: true },
      stored,
    );
    expect(merged.onlyDomain).to.deep.equal(['drive.google.com']);
  });

  it('suppresses the local config when replaying a stored exclusion list', () => {
    const merged = mergeStoredSettings({ defaultExcludes: true }, stored);
    expect(merged.defaultExcludes).to.equal(false);
  });

  it('keeps the local config in force when the user supplies exclusions', () => {
    const merged = mergeStoredSettings(
      { excludeDomain: ['okta.com'], defaultExcludes: true },
      stored,
    );
    expect(merged.defaultExcludes).to.equal(true);
    expect(merged.excludeDomain).to.deep.equal(['okta.com']);
  });

  // The documented purpose of the flag: refresh a profile that needs a
  // normally-excluded domain. Before this it was silently ignored on refresh.
  // Note it clears ONLY the exclusion list — the next test pins the rest.
  it('clears only the stored exclusion list when --no-default-excludes is passed explicitly', () => {
    const merged = mergeStoredSettings({ defaultExcludes: false }, stored);
    expect(merged.excludeDomain).to.deep.equal([]);
    expect(merged.defaultExcludes).to.equal(false);
  });

  it('still inherits the other stored fields when exclusions are opted out', () => {
    const merged = mergeStoredSettings({ defaultExcludes: false }, stored);
    expect(merged.browser).to.equal('chrome');
    expect(merged.onlyDomain).to.deep.equal(['mail.google.com']);
  });

  it('keeps the local config in force when nothing was stored to replay', () => {
    const merged = mergeStoredSettings(
      { defaultExcludes: true },
      {
        browser: 'chrome',
        cliVersion: '0.2.0',
      },
    );
    expect(merged.defaultExcludes).to.equal(true);
  });

  /**
   * `--exclude-domain "$UNSET_VAR"` yields `['']`, which excludes nothing. Treating it
   * as "the user supplied a list" both skipped the replay and erased the stored list,
   * so the profile silently lost its exclusions and captured what they kept out.
   */
  it('ignores a flag list whose every entry normalizes away', () => {
    const merged = mergeStoredSettings({ excludeDomain: [''] }, stored);
    expect(merged.excludeDomain).to.deep.equal(['chase.com']);
    expect(merged.defaultExcludes).to.equal(false);
  });

  it('still honours a list with at least one usable pattern', () => {
    const merged = mergeStoredSettings(
      { excludeDomain: ['', 'okta.com'], defaultExcludes: true },
      stored,
    );
    expect(merged.excludeDomain).to.deep.equal(['', 'okta.com']);
    expect(merged.defaultExcludes).to.equal(true);
  });

  /**
   * A stored `[]` means the original capture deliberately excluded nothing. Testing
   * `.length` instead of presence made that indistinguishable from "unknown", so a
   * refresh re-applied the refreshing machine's own list and dropped auth state the
   * original kept on purpose. Both assertions fail under a `.length` test.
   */
  it('suppresses the local config for a stored EMPTY exclusion list', () => {
    const merged = mergeStoredSettings(
      { defaultExcludes: true },
      { browser: 'chrome', excludeDomains: [], cliVersion: '0.2.0' },
    );
    expect(merged.defaultExcludes).to.equal(false);
    expect(merged.excludeDomain).to.deep.equal([]);
  });

  it('still lets an explicit --exclude-domain override a stored empty list', () => {
    const merged = mergeStoredSettings(
      { excludeDomain: ['okta.com'], defaultExcludes: true },
      { browser: 'chrome', excludeDomains: [], cliVersion: '0.2.0' },
    );
    expect(merged.excludeDomain).to.deep.equal(['okta.com']);
    expect(merged.defaultExcludes).to.equal(true);
  });
});

/**
 * The chain this pins: a member absent from `SETTINGS_REPLAY_SOURCE` is a compile
 * error, and a member present but not actually carried by build → merge fails here.
 * Without both, a new capture flag is silently never stored AND silently erased from
 * the column by the next refresh, because the update replaces wholesale.
 */
describe('cli-utils/capture-runner replay-source completeness', () => {
  const FLAG_FIXTURE: Required<
    Omit<CaptureFlags, 'acceptTerms' | 'termsTtlDays'>
  > = {
    browser: 'cli-capture-chrome',
    profile: 'Profile 1',
    excludeDomain: ['chase.com'],
    defaultExcludes: true,
    passwordStore: 'gnome-libsecret',
    autoFit: true,
    keepDomain: ['github.com'],
    onlyDomain: ['mail.google.com'],
  };

  // A member cannot borrow another's flag: aliasing two entries onto one key made the
  // round-trip below pass while the second member replayed the wrong source.
  it('maps each member to a distinct flag', () => {
    const flags = Object.values(SETTINGS_REPLAY_SOURCE);
    expect(new Set(flags).size).to.equal(flags.length);
  });

  /**
   * Value-level, not presence-level. Asserting only `!== undefined` on both sides let a
   * mis-wire like `regionHint: flags.regionHint ?? stored.browser` pass, because both
   * ends were merely non-undefined.
   */
  it('round-trips every replayable member through build then merge', () => {
    const settings = buildCaptureSettings(
      FLAG_FIXTURE,
      { excludedDomains: ['chase.com'] },
      'upload',
    );
    // A flagless refresh: nothing supplied, everything must come from `stored`.
    const merged = mergeStoredSettings({}, settings);
    Object.entries(SETTINGS_REPLAY_SOURCE).forEach(([settingsKey, flagKey]) => {
      const storedValue = settings?.[settingsKey as keyof typeof settings];
      expect(storedValue, `${settingsKey} was never stored`).to.not.equal(
        undefined,
      );
      expect(
        merged[flagKey],
        `${settingsKey} was stored but not replayed onto --${flagKey}`,
      ).to.deep.equal(storedValue);
    });
  });
});

describe('cli-utils/capture-runner.runCapture diagnostics', () => {
  it('escapes all diagnostic fields without changing capture data or trusted layout', async () => {
    const home = await setupTempHome();
    try {
      // Replace only browser discovery/capture, which require an installed browser.
      // Exercise the real merge, filter, diagnostics and result paths in a fresh process.
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          '--experimental-test-module-mocks',
          '--input-type=module',
          '-e',
          `
          import { mock } from 'node:test';
          mock.module(${JSON.stringify(new URL('../browsers/discover.js', import.meta.url).href)}, {
            namedExports: { loadSourceCandidates: async () => [], resolveProfile: async () => ({
              browserKey: 'chrome', profileDirName: 'Default',
              browserDisplayName: 'Chrome\\nforged-browser',
              profileDisplayName: 'Default\\nforged-profile',
              binaryPath: 'C:\\\\Chrome\\\\chrome.exe'
            }) }
          });
          mock.module(${JSON.stringify(new URL('../capture/index.js', import.meta.url).href)}, {
            namedExports: { captureFromProfile: async (opts) => {
              opts.onProgress({ phase: 'waiting-for-unlock', relativePath: 'Default\\\\Network\\\\Cookies', browserRunning: true, code: 'EBUSY' });
              opts.onProgress({ phase: 'capturing-origins', attempted: 1, total: 1, origin: 'https://progress.example/\\nforged-progress' });
              const state = { cookies: [], origins: [
                { origin: 'https://keep.example/\\nforged-keep\\u009b', localStorage: { x: 'x'.repeat(2200000) } },
                { origin: 'https://drop.example/\\nforged-drop\\u007f', localStorage: { x: 'x'.repeat(1200000) } }
              ] };
              return {
              state, serialized: JSON.stringify(state),
              capHit: false, passwordStoreDefaulted: false,
              diagnostics: {
                cookieCountBeforeExclusion: 1, cookieCountExcluded: 1,
                originCountBeforeExclusion: 1, originCountExcluded: 0,
                originCountSkippedByOnlyDomain: 1,
                excludedDomains: opts.excludedDomains,
                onlyDomains: opts.onlyDomains, durationMs: 1,
                failedOrigins: [{ origin: 'https://failed.example/\\nforged-origin', error: 'failed\\nforged-error\\u007f' }]
              }
            }; } }
          });
          const { runCapture, mergeStoredSettings } = await import(${JSON.stringify(new URL('./capture-runner.js', import.meta.url).href)});
          const stored = {
            browser: 'chrome', profile: 'Default',
            onlyDomains: ['keep.example', 'drop.example', 'only\\u009b31m'],
            excludeDomains: ['exclude\\u001b[2J\\u007f'],
            autoFit: true, keepDomains: ['keep.example']
          };
          const flags = mergeStoredSettings({}, stored);
          const result = await runCapture({ flags, requiresDisclaimer: false, missingSource: 'stored-settings' });
          const picked = await runCapture({ flags: {}, requiresDisclaimer: false, missingSource: 'flags',
            sourceSeams: { isInteractive: true, prompt: async () => '2', write: () => {},
              loadCandidates: async () => [
                { browserKey: 'picker-a', profileDirName: 'Profile 1', browserDisplayName: 'Picker A', profileDisplayName: 'Work', binaryPath: '/fake/browser-a' },
                { browserKey: 'picker-b', profileDirName: 'Default', browserDisplayName: 'Picker B', profileDisplayName: 'Personal', binaryPath: '/fake/browser-b' },
              ]
            } });
          console.log(JSON.stringify({ flags, diagnostics: result.diagnostics, source: picked.source }));
        `,
        ],
        { env: { ...process.env, HOME: home.path, USERPROFILE: home.path } },
      );
      expect(stderr).to.include(
        'not matching: keep.example, drop.example, only\\u009b31m\n',
      );
      expect(stderr).to.include('matching: exclude\\u001b[2J\\u007f\n');
      expect(stderr).to.include(
        '> Capturing Chrome\\u000aforged-browser / Default\\u000aforged-profile\n',
      );
      expect(stderr).to.include(
        '  Chrome\\u000aforged-browser is still running, so Windows keeps Default\\Network\\Cookies locked.\n',
      );
      expect(stderr).to.include(
        'https://progress.example/\\u000aforged-progress\n',
      );
      expect(stderr).to.include(
        'https://failed.example/\\u000aforged-origin: failed\\u000aforged-error\\u007f\n',
      );
      expect(stderr).to.include('heaviest origins:\n');
      expect(stderr).to.include(
        'protected by --keep-domain:\n      - https://keep.example/\\u000aforged-keep\\u009b\n',
      );
      expect(stderr).to.include(
        '      - https://drop.example/\\u000aforged-drop\\u007f\n',
      );
      expect(stderr).not.to.include('\nforged');
      // eslint-disable-next-line no-control-regex
      expect(stderr).not.to.match(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
      const { flags, diagnostics, source } = JSON.parse(stdout);
      expect(source).to.deep.equal({ browser: 'picker-b', profile: 'Default' });
      expect(stderr).to.include('> Capturing Picker B / Personal\n');
      expect(flags.onlyDomain).to.deep.equal([
        'keep.example',
        'drop.example',
        'only\x9b31m',
      ]);
      expect(diagnostics.excludedDomains).to.deep.equal(['exclude\x1b[2J\x7f']);
      expect(diagnostics.failedOrigins[0].error).to.equal(
        'failed\nforged-error\x7f',
      );
    } finally {
      await home.cleanup();
    }
  });
});

describe('cli-utils/capture-runner.runCapture missing-source guard', () => {
  const candidate = {
    browserKey: 'picker-a',
    browserDisplayName: 'Picker A',
    profileDirName: 'Default',
    profileDisplayName: 'Work',
    binaryPath: '/fake/browser',
    userDataDir: '/fake/data',
    profilePath: '/fake/data/Default',
  };

  for (const [flags, interactive, code, message] of [
    [{}, true, 'no-local-profiles', 'No browser profiles were found'],
    [
      {},
      false,
      'missing-required-flag',
      '--browser and --profile are required',
    ],
    [
      { browser: 'picker-a' },
      false,
      'missing-required-flag',
      '--profile is required',
    ],
  ] as const) {
    it(`reports ${code}: ${message}`, async () => {
      const err = await runCapture({
        flags,
        requiresDisclaimer: false,
        missingSource: 'flags',
        sourceSeams: {
          isInteractive: interactive,
          loadCandidates: async () => (interactive ? [] : [candidate]),
        },
      }).catch((error: unknown) => error);
      expect(err).to.be.instanceOf(UsageError).with.property('code', code);
      expect((err as Error).message).to.include(message);
      if (!interactive)
        expect((err as Error).message).to.include(
          '--browser picker-a --profile "Default"',
        );
    });
  }

  it('rejects a declined picker before asking for the disclaimer', async () => {
    const home = await setupTempHome();
    try {
      const err = await runCapture({
        flags: {},
        requiresDisclaimer: true,
        missingSource: 'flags',
        sourceSeams: {
          isInteractive: true,
          loadCandidates: async () => [
            candidate,
            { ...candidate, browserKey: 'picker-b' },
          ],
          prompt: async () => {
            throw new Error('closed');
          },
          write: () => {},
        },
      }).catch((error: unknown) => error);
      expect(err)
        .to.be.instanceOf(UsageError)
        .with.property('code', 'invalid-source-choice');
    } finally {
      await home.cleanup();
    }
  });

  const rejects = async (
    flags: CaptureFlags,
  ): Promise<{ err: unknown; message: string }> => {
    try {
      await runCapture({
        flags,
        requiresDisclaimer: false,
        missingSource: 'stored-settings',
        sourceSeams: {
          isInteractive: false,
          loadCandidates: async () => [candidate],
        },
      });
      throw new Error('expected runCapture to reject');
    } catch (err) {
      return { err, message: (err as Error).message };
    }
  };

  it('rejects with both flags named when neither was read', async () => {
    const { err, message } = await rejects({});
    expect(err).to.be.instanceOf(UsageError);
    expect((err as UsageError).code).to.equal('missing-capture-settings');
    expect(message).to.match(/--browser and --profile are required/);
  });

  it('rejects with only the missing flag named, in the singular', async () => {
    const { message } = await rejects({ browser: 'chrome' });
    expect(message).to.match(/--profile is required/);
    expect(message).to.not.match(/--browser and/);
  });

  /**
   * Without the cause the same text is produced by a server too old to return the
   * settings, where the fix is to update the server rather than to pass flags.
   */
  it('names both causes, so a version skew is not read as a user typo', async () => {
    const { message } = await rejects({});
    expect(message).to.match(/no stored capture settings/);
    expect(message).to.match(/not created by the CLI/);
    expect(message).to.match(/does not return them yet/);
  });
});

/**
 * The user pasted a command with no flags, so the settings are invisible until
 * this prints them. `--only-domain` must be called out: refresh replaces the
 * profile wholesale, so a narrow filter discards every credential outside it.
 */
/**
 * The user pasted a command with no flags, so the settings are invisible until this
 * prints them. Three facts must stay separate, because collapsing any two of them
 * printed something the run then contradicted:
 *   configOff       — this machine's `excluded_domains` is suppressed
 *   nothingExcluded — the effective list is empty, so a `[]` write follows
 *   storedCount     — what the profile had, which a loss is measured against
 *
 * `userOptedOut` is passed from argv rather than inferred, because
 * `mergeStoredSettings` also sets `defaultExcludes: false` when replaying a stored
 * list. Inferring it made the two-flag case claim this machine's config applied when
 * it had been suppressed — cookies the config existed to keep out were captured,
 * uploaded, AND frozen into the profile.
 */
describe('cli-utils/capture-runner.printEffectiveSettings', () => {
  let stderr: Sinon.SinonStub;
  beforeEach(() => {
    stderr = Sinon.stub(process.stderr, 'write').returns(true);
  });
  afterEach(() => {
    Sinon.restore();
  });
  const out = (): string =>
    stderr
      .getCalls()
      .map((c) => String(c.args[0]))
      .join('');

  const base = { browser: 'chrome', profile: 'Default' };
  const show = (
    flags: Parameters<typeof printEffectiveSettings>[0],
    stored: Parameters<typeof printEffectiveSettings>[1],
    userOptedOut = false,
  ) => printEffectiveSettings({ ...base, ...flags }, stored, { userOptedOut });

  it('says nothing when the profile has no stored settings', () => {
    show({}, null);
    expect(out()).to.equal('');
  });

  it('escapes terminal controls in remote stored settings without changing flags', () => {
    const profile = 'work\x1b]52;c;YQ==\x07\rnext';
    const flags = { profile };
    show(flags, { profile });
    expect(out()).to.include(
      '--profile work\\u001b]52;c;YQ==\\u0007\\u000dnext',
    );
    expect(flags.profile).to.equal(profile);
  });

  it('prints the effective browser and profile', () => {
    show({}, { browser: 'chrome', cliVersion: '0.2.0' });
    expect(out()).to.match(/--browser chrome/);
    expect(out()).to.match(/--profile Default/);
    // Deliberately not a blanket "override anything": auto-fit has no off switch and
    // a repeatable flag cannot express an empty list.
    expect(out()).to.match(/Pass --browser, --profile/);
    expect(out()).to.not.match(/Override any of these/);
  });

  it('omits a member it does not have rather than printing undefined', () => {
    show({ profile: undefined }, { browser: 'chrome', cliVersion: '0.2.0' });
    expect(out()).to.match(/--browser chrome/);
    expect(out()).to.not.match(/undefined/);
    expect(out()).to.not.match(/\n {4}--profile/);
  });

  it('warns that --only-domain discards the rest of the profile', () => {
    show(
      { onlyDomain: ['mail.google.com'] },
      { onlyDomains: ['mail.google.com'] },
    );
    expect(out()).to.match(/--only-domain mail\.google\.com/);
    expect(out()).to.match(/only these domains are captured/);
    expect(out()).to.match(/everything else in the saved/);
    expect(out()).to.match(/replaced, not kept/);
  });

  it('notes that auto-fit only acts past the cap', () => {
    show({ autoFit: true }, { autoFit: true });
    expect(out()).to.match(/--auto-fit \(only acts/);
  });

  // ---- the exclusion matrix -------------------------------------------------
  // Every row below is a (userOptedOut, --exclude-domain, stored) combination. Rows
  // marked NEW had no coverage before: the two-flag rows are the ones that printed a
  // falsehood, and no prior spec could distinguish them because the old fixture got
  // `defaultExcludes: false` from the merge rather than from the flag.

  it('opt-out over a stored list: reports the count AND the write', () => {
    show(
      { excludeDomain: [], defaultExcludes: false },
      { excludeDomains: ['chase.com', 'okta.com'], cliVersion: '0.2.0' },
      true,
    );
    expect(out()).to.match(
      /--no-default-excludes drops the 2 stored exclusion/,
    );
    expect(out()).to.match(/stored with NO exclusion list/);
    expect(out()).to.match(/re-pass --exclude-domain if you want to keep them/);
  });

  /**
   * The write happens whether or not there was a list to lose, and nothing-stored is
   * the NORMAL first-upload shape — so gating the whole disclosure on a stored count
   * left exactly that user silently pinned to "exclude nothing" forever.
   */
  it('opt-out with nothing stored: still reports the permanent write', () => {
    show(
      { excludeDomain: [], defaultExcludes: false },
      { browser: 'chrome', cliVersion: '0.2.0' },
      true,
    );
    expect(out()).to.match(/stored with NO exclusion list/);
    expect(out()).to.match(/stop applying this machine's config/);
    expect(out()).to.not.match(/drops the/);
  });

  /**
   * NEW. The two-flag case, and the reason `userOptedOut` is threaded through: the
   * config IS suppressed, so neither the absent-list line nor the "re-applies your
   * config" hint may print. Previously both did, while the run excluded only
   * `bank.example` and uploaded everything the config was there to protect.
   */
  it('opt-out WITH an explicit list: says only those patterns apply', () => {
    show(
      { excludeDomain: ['bank.example'], defaultExcludes: false },
      { browser: 'chrome', cliVersion: '0.2.0' },
      true,
    );
    expect(out()).to.match(/ONLY the --exclude-domain patterns above/);
    expect(out()).to.match(/config is not applied/);
    // The three claims that were false here.
    expect(out()).to.not.match(/this machine's own config applies/);
    expect(out()).to.not.match(/re-applies this machine's config/);
    expect(out()).to.not.match(/stored with NO exclusion list/);
  });

  it('opt-out WITH an explicit list, over a stored list: same, no false loss claim', () => {
    show(
      { excludeDomain: ['bank.example'], defaultExcludes: false },
      { excludeDomains: ['chase.com'], cliVersion: '0.2.0' },
      true,
    );
    expect(out()).to.match(/ONLY the --exclude-domain patterns above/);
    expect(out()).to.not.match(/re-applies this machine's config/);
  });

  it('no stored list, no opt-out: the local config applies, and gets snapshotted', () => {
    show({ defaultExcludes: true }, { browser: 'chrome', cliVersion: '0.2.0' });
    expect(out()).to.match(/no stored exclusion list/);
    expect(out()).to.match(/this machine's own config applies/);
    // NEW: the forward-looking half. This run freezes the effective list onto the
    // profile, so a later `profile exclude add` is ignored by flagless refreshes.
    expect(out()).to.match(
      /replay that snapshot instead of re-reading this config/,
    );
    // And the hint must not claim there is a list to replace.
    expect(out()).to.match(/there is no stored list to replace/);
  });

  it('replaying a stored empty list reports the write', () => {
    show(
      { excludeDomain: [], defaultExcludes: false },
      { excludeDomains: [], cliVersion: '0.2.0' },
      true,
    );
    expect(out()).to.match(/stored with NO exclusion list/);
    expect(out()).to.not.match(/drops the/);
  });

  /**
   * An explicit flag over a stored `[]` must not claim the run excludes
   * nothing — it excludes the flag's domain AND re-unions this machine's config.
   */
  /**
   * The merge keeps the list verbatim so an all-unusable list stays distinguishable, so
   * the print site is where dead entries must be dropped: `['', 'okta.com']` rendered
   * as a leading comma and implied the run excluded something it did not.
   */
  it('prints only the entries that survive normalization', () => {
    show({ excludeDomain: ['', 'okta.com'] }, { excludeDomains: ['okta.com'] });
    expect(out()).to.match(/--exclude-domain okta\.com/);
    expect(out()).to.not.match(/--exclude-domain , okta/);
  });

  /**
   * An opt-out whose whole list normalizes away excludes nothing and writes `[]`, so it
   * belongs in the permanent-write branch — a raw `.length` test routed it to the
   * "ONLY these patterns" branch and named patterns that were never in force.
   */
  it('treats an all-unusable list under opt-out as excluding nothing', () => {
    show(
      { excludeDomain: [''], defaultExcludes: false },
      { excludeDomains: ['chase.com'], cliVersion: '0.2.0' },
      true,
    );
    expect(out()).to.match(/stored with NO exclusion list/);
    expect(out()).to.not.match(/ONLY the --exclude-domain patterns/);
  });

  it('never claims "excludes nothing" while an explicit flag is in force', () => {
    show(
      { excludeDomain: ['bank.example'], defaultExcludes: false },
      {
        excludeDomains: [],
        cliVersion: '0.2.0',
      },
    );
    expect(out()).to.match(/--exclude-domain bank\.example/);
    // Asserted against strings the source actually emits. `/excludes nothing/` appears
    // only in comments since the branch that printed it was removed, so it was a dead
    // negative that could never fail.
    expect(out()).to.not.match(/stored with NO exclusion list/);
    expect(out()).to.not.match(/drops the/);
  });

  /**
   * This stderr line is the only place the CLI discloses that an explicit
   * --exclude-domain re-applies the refreshing machine's own config.
   */
  it('discloses that an explicit --exclude-domain re-applies the local config', () => {
    show(
      { excludeDomain: ['chase.com'], defaultExcludes: false },
      {
        excludeDomains: ['chase.com'],
        cliVersion: '0.2.0',
      },
    );
    expect(out()).to.match(/re-applies this machine's config/);
    expect(out()).to.match(
      /--no-default-excludes drops the stored list for good/,
    );
  });

  it('suppresses both override hints when the user opted out', () => {
    show(
      { excludeDomain: [], defaultExcludes: false },
      { excludeDomains: ['chase.com'], cliVersion: '0.2.0' },
      true,
    );
    expect(out()).to.not.match(/re-applies this machine's config/);
    expect(out()).to.not.match(/adds to this machine's config/);
    expect(out()).to.not.match(/--no-default-excludes drops the stored list/);
  });

  /**
   * NEW. `buildCaptureSettings` decides the write AFTER the capture and returns
   * undefined past the 8 KB cap, leaving the stored object intact — so an unqualified
   * "stored with NO exclusion list" was a false alarm of permanent loss, printed
   * before the user could even Ctrl-C.
   */
  it('qualifies the write on the 8 KB cap rather than asserting it', () => {
    show(
      { excludeDomain: [], defaultExcludes: false },
      { excludeDomains: ['chase.com'], cliVersion: '0.2.0' },
      true,
    );
    expect(out()).to.match(/Unless the settings exceed the 8 KB cap/);
  });
});
