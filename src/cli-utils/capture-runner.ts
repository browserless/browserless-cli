import {
  loadSourceCandidates,
  resolveProfile,
  type DetectedProfile,
} from '../browsers/discover.js';
import { pickSourceProfile, type SourcePickerSeams } from './source-picker.js';
import {
  CaptureOptions,
  CaptureResult,
  type CaptureProgressEvent,
  captureFromProfile,
} from '../capture/index.js';
import {
  applyOnlyFilter,
  mergeExclusionPatterns,
  normalizeExclusion,
} from '../capture/exclusion.js';
import { readConfig } from '../config/store.js';
import { ensureTermsAccepted, isCi } from '../auth/disclaimer.js';
import { formatProfileLockedMessage } from '../capture/profile-lock.js';
import { CDP_SILENCE_RESTART_MS } from '../capture/launch.js';
import { UsageError } from '../errors.js';
import { version } from '../version.js';
import { terminalSafe } from '../utils/terminal.js';
import type {
  CaptureDiagnostics,
  ProfileCaptureSettings,
} from '../capture/types.js';
import { collectRepeated, parseNonNegativeInt } from './client.js';
import {
  formatBytes,
  measureOriginSizes,
  SERVER_ARTIFACT_CAP_BYTES,
  trimStateToFit,
} from './trim-state.js';
import type { Command } from 'commander';

export const captureIsInteractive = (
  stdinIsTTY: boolean | undefined,
  ci: boolean,
): boolean => stdinIsTTY === true && !ci;

export const createProgressRenderer = (
  detected: Pick<
    DetectedProfile,
    'browserDisplayName' | 'profileDisplayName' | 'binaryPath'
  >,
  writeLine: (line: string) => void,
): ((event: CaptureProgressEvent) => void) => {
  // Each phase / origin-tick emits its own line (no `\r` in-place tricks).
  // Plain line-per-event is reliable across every terminal, ssh setup, log
  // pipe, IDE-integrated console, and copy-paste pattern — at the cost of
  // some vertical noise. To keep the noise bounded, the capturing-origins
  // phase throttles to one line per N origins (final origin always emits).
  const PROGRESS_THROTTLE = 5;
  const phaseLabel: Record<string, string> = {
    copying: 'copying profile data…',
    launching: 'launching headless browser…',
    'waiting-for-debugger': 'waiting for browser to be ready…',
    'restarting-browser': `browser did not respond in ${CDP_SILENCE_RESTART_MS / 1000}s; restarting it…`,
  };
  let lastPhase = '';
  let lastReportedAttempt = 0;
  return (event) => {
    if (event.phase === 'done') return;
    if (event.phase === 'waiting-for-unlock') {
      formatProfileLockedMessage(detected, event, 'wait')
        .split('\n')
        .forEach(writeLine);
      return;
    }
    if (event.phase === 'capturing-origins') {
      // The first emit (attempted=0, total=0) just announces the
      // phase before we know how many origins we'll attempt.
      if (event.attempted === 0) {
        if (lastPhase !== 'capturing-origins') {
          lastPhase = 'capturing-origins';
          writeLine('capturing per-origin storage…');
        }
        return;
      }
      // Throttle to every Nth origin so a 50-origin run doesn't flood
      // the terminal with 50 lines. Always print the final origin so
      // the user sees the loop reach completion.
      const isLast = event.attempted === event.total;
      if (!isLast && event.attempted - lastReportedAttempt < PROGRESS_THROTTLE)
        return;
      lastReportedAttempt = event.attempted;
      // Truncate the origin URL so we don't wrap on narrow terminals.
      const shortOrigin =
        event.origin.length > 50
          ? event.origin.slice(0, 47) + '…'
          : event.origin;
      writeLine(`  ${event.attempted}/${event.total}  ${shortOrigin}`);
      return;
    }
    // Other phases (copying / launching / waiting-for-debugger) —
    // only print when it's a new phase to avoid re-emitting the same
    // label across redundant renders.
    if (event.phase !== lastPhase) {
      lastPhase = event.phase;
      writeLine(phaseLabel[event.phase] ?? event.phase);
    }
  };
};

/** Which wire verb the settings are being built for — see `warnOverCap`. */
export type CaptureVerb = 'upload' | 'refresh';

/** Shared flags for `profile upload`, `profile refresh`, `profile inspect`. */
export interface CaptureFlags {
  browser?: string;
  profile?: string;
  excludeDomain?: string[];
  /**
   * Commander camelCases `--no-default-excludes` into `defaultExcludes`,
   * not `noDefaultExcludes`. Defaults to `true`; `false` when the flag
   * is passed.
   */
  defaultExcludes?: boolean;
  acceptTerms?: boolean;
  termsTtlDays?: string;
  passwordStore?: string;
  /**
   * Drop the heaviest origins post-capture until the serialized artifact
   * fits under the server's profile-artifact cap. Surfaced as the
   * `--auto-fit` flag.
   */
  autoFit?: boolean;
  /**
   * Domains that `--auto-fit` must never drop. Same suffix-matching
   * semantics as `--exclude-domain`. Surfaced as `--keep-domain`.
   * Repeatable: each invocation appends to the list.
   */
  keepDomain?: string[];
  /**
   * Allowlist counterpart to `--exclude-domain`: when set, ONLY cookies
   * and origins whose hostname suffix-matches one of these patterns
   * survive the capture. Surfaced as `--only-domain`. Applied
   * post-capture, before the auto-fit size pass. Empty / omitted means
   * "keep everything (the exclusion list still applies)".
   */
  onlyDomain?: string[];
}

export const addCaptureFlags = (
  cmd: Command,
  opts: { sourceOptional?: boolean } = {},
): Command => {
  const suffix = (kind: string) =>
    opts.sourceOptional
      ? ". Optional here — read from the profile's stored settings when omitted (asks in a terminal when nothing is stored)"
      : `. Optional in a terminal: leave it out to choose from the ${kind} found on this machine`;
  cmd.option(
    '--browser <key>',
    `Source browser key (chrome / brave / edge / ...) or display name${suffix('browsers')}`,
  );
  cmd.option(
    '--profile <name>',
    `Source profile display name or directory (e.g. "Personal", "Default")${suffix('profiles')}`,
  );
  return cmd
    .option(
      '--exclude-domain <domain>',
      'Append a domain to the exclusion list for this run (repeatable)',
      collectRepeated,
    )
    .option(
      '--no-default-excludes',
      'Skip the persistent exclusion list for this run',
    )
    .option('--accept-terms', 'Pre-accept the liability disclaimer')
    .option(
      '--terms-ttl-days <n>',
      'Override the disclaimer re-prompt TTL for this run',
    )
    .option(
      '--password-store <store>',
      'Linux only: --password-store value to pass through to the headless launch (basic / gnome-libsecret / kwallet5 / ...)',
    )
    .option(
      '--auto-fit',
      'If the captured artifact exceeds the 2 MB server cap, drop the heaviest origins (largest serialized contribution first) until it fits',
    )
    .option(
      '--keep-domain <domain>',
      'Domain that --auto-fit must never drop (suffix-match, same syntax as --exclude-domain; repeatable)',
      collectRepeated,
    )
    .option(
      '--only-domain <domain>',
      'Capture only cookies / origins matching this domain — discard everything else (suffix-match; repeatable; applies after --exclude-domain)',
      collectRepeated,
    );
};

/**
 * Without this the pre-navigation filter inside the capture loop drops
 * every origin (no pattern in the list ever matches anything) while the
 * post-capture `applyOnlyFilter` no-ops on the same input — the two would
 * silently disagree and the user would get an empty upload with no
 * explanation.
 */
export const validateOnlyDomain = (onlyDomain: string[]): void => {
  if (
    onlyDomain.length > 0 &&
    !onlyDomain.some((p) => normalizeExclusion(p) !== null)
  ) {
    throw new UsageError(
      `--only-domain: no valid domain pattern in ${JSON.stringify(onlyDomain)}. Use a hostname like "example.com" or "*.example.com".`,
      'invalid-only-domain',
    );
  }
};

/**
 * Server-side caps, mirrored here — see AGENTS.md "Mirrored caps". The server rejects the whole request on a
 * violation, which would fail an upload over metadata, so bound here instead.
 */
const MAX_SETTINGS_DOMAINS = 100;
const MAX_SETTINGS_DOMAIN_LENGTH = 253;
const MAX_SETTINGS_FIELD_LENGTH = 255;
const MAX_SETTINGS_BYTES = 8 * 1024;

/**
 * The server rejects these characters in the scalar members. A Chrome profile really
 * can be called `Bob's $tuff`, so drop the member rather than fail the upload over it.
 */
// eslint-disable-next-line no-control-regex
const SETTINGS_UNSAFE_SCALAR = /[$`\\!\u0000-\u001f\u007f]/;

/** Mirrors the server's `CAPTURE_SETTINGS_DOMAIN_PATTERN`. */
const SETTINGS_DOMAIN_PATTERN = /^[A-Za-z0-9*._-]+$/;

/**
 * Dropping a member is silent by nature, and a dropped `--profile` or a truncated
 * exclusion list changes what a flagless refresh captures — so say so.
 */
const warnDropped = (what: string, why: string): void => {
  process.stderr.write(
    `  → Not storing ${what} for refresh (${why}); a later flagless \`profile refresh\` of this profile will not replay it\n`,
  );
};

/**
 * Omitting `captureSettings` creates a row with none on upload, but tells the
 * server to leave the stored settings untouched on refresh — so on refresh whatever
 * was already stored survives unchanged. Never claim otherwise.
 */
const warnOverCap = (verb: CaptureVerb): void => {
  const limit = `they serialize past the server's ${MAX_SETTINGS_BYTES}-byte limit`;
  process.stderr.write(
    verb === 'upload'
      ? `  → Not storing any capture settings (${limit}); a later flagless \`profile refresh\` of this profile will have nothing to replay\n`
      : `  → Not updating the stored capture settings (${limit}); whatever this profile already had is left as it was, so it no longer matches this run and a later flagless \`profile refresh\` will not reflect these filters. Shorten the domain lists to update them\n`,
  );
};

const safeScalar = (key: string, raw?: string): string | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  if (SETTINGS_UNSAFE_SCALAR.test(value)) {
    warnDropped(`--${key}`, 'it contains characters a shell would interpret');
    return undefined;
  }
  if (value.length > MAX_SETTINGS_FIELD_LENGTH) {
    warnDropped(
      `--${key}`,
      `it exceeds ${MAX_SETTINGS_FIELD_LENGTH} characters`,
    );
    return undefined;
  }
  return value;
};

/**
 * Normalized to the hostnames the capture actually matches on, which is both the
 * true "effective" list a refresh replays and the only form the server accepts — it
 * rejects the URL and non-ASCII spellings `normalizeExclusion` supports as input.
 *
 * `preserveEmpty` keeps `[]` instead of collapsing to `undefined`, recording "captured
 * with no exclusions" as distinct from "unknown". Only `excludeDomains` needs it, and
 * only when the user actually opted out: `excluded_domains` has no default, so an
 * empty effective list is the NORMAL state for a first upload, and storing `[]` for
 * that would make a later flagless refresh suppress a config the user added in the
 * meantime — the same cross-machine leak in the opposite direction.
 */
const safeDomains = (
  key: string,
  values?: string[],
  preserveEmpty = false,
): string[] | undefined => {
  const parsed = [
    ...new Set(
      (values ?? [])
        .map((value) => normalizeExclusion(value))
        .filter((value): value is string => value !== null),
    ),
  ];
  const normalized = parsed.filter(
    (value) =>
      value.length <= MAX_SETTINGS_DOMAIN_LENGTH &&
      SETTINGS_DOMAIN_PATTERN.test(value),
  );
  // Same reason the truncation below is loud: a refresh replays the stored list in
  // place of the local config. A bracketed IPv6 literal is honored by the capture but
  // rejected by the server's pattern, so dropping it silently would make the replay
  // stop excluding a host this run did exclude. Counted against `parsed`, not the raw
  // input: `normalizeExclusion` nulls only blank/degenerate patterns and the Set only
  // collapses duplicates, and neither could have filtered anything, so warning about
  // them would be noise.
  if (normalized.length < parsed.length) {
    warnDropped(
      `${parsed.length - normalized.length} of ${parsed.length} --${key} patterns`,
      'the server only stores plain hostname patterns',
    );
  }
  // `[]` only for a genuinely empty input. If entries were supplied and all
  // normalized away, the caller meant to exclude something, so this is "unknown"
  // rather than "deliberately none" — same distinction the server draws.
  if (!normalized.length) {
    return preserveEmpty && !(values ?? []).length ? [] : undefined;
  }

  if (normalized.length > MAX_SETTINGS_DOMAINS) {
    // A refresh replays the stored list in place of the local config, so a truncated
    // list means the replay would capture domains this run excluded. Loud, because it
    // is a privacy control.
    warnDropped(
      `${normalized.length - MAX_SETTINGS_DOMAINS} of ${normalized.length} --${key} patterns`,
      `the server stores at most ${MAX_SETTINGS_DOMAINS}`,
    );
  }
  return normalized.slice(0, MAX_SETTINGS_DOMAINS);
};

/**
 * Correlates the key with its declared member type. Taking `key: string` let a
 * misnamed or wrongly-typed member compile, and the far side rejects the whole
 * request — so the upload would 400 only after a full browser capture had run.
 * `Partial<Pick<…>>` is load-bearing: TS cannot prove a generic `Pick` is all
 * optional, so a bare `Pick` return rejects the `{}` branch.
 */
const withKey = <K extends keyof ProfileCaptureSettings>(
  key: K,
  value: ProfileCaptureSettings[K],
): Partial<Pick<ProfileCaptureSettings, K>> =>
  value === undefined
    ? {}
    : ({ [key]: value } as Pick<ProfileCaptureSettings, K>);

/**
 * Members deliberately NOT replayed. Naming one here is the only way out of the table
 * below, so skipping a member is an explicit, reviewable act rather than a `null` a
 * copy-paste can produce by accident. A typo'd name removes nothing, so the table then
 * demands the real member and the build fails — the escape hatch cannot be fumbled.
 */
type NotReplayed = 'cliVersion';

/**
 * Every replayable member of the wire type, mapped to the `CaptureFlags` key a refresh
 * replays it from. Adding a member to `ProfileCaptureSettings` is a compile error here,
 * which is what stops it from being silently never-written by `buildCaptureSettings`
 * and then silently erased from the column by the next refresh (the update replaces
 * wholesale). `capture-runner.spec.ts` drives a value-level round-trip off this table
 * and asserts the mapping is injective, so an entry must also be wired correctly and
 * cannot borrow another member's flag.
 */
export const SETTINGS_REPLAY_SOURCE: Record<
  Exclude<keyof Required<ProfileCaptureSettings>, NotReplayed>,
  keyof CaptureFlags
> = {
  browser: 'browser',
  profile: 'profile',
  excludeDomains: 'excludeDomain',
  onlyDomains: 'onlyDomain',
  keepDomains: 'keepDomain',
  autoFit: 'autoFit',
  passwordStore: 'passwordStore',
};

/**
 * Pass `result.diagnostics`, never `flags.excludeDomain`: `excludedDomains` is
 * the EFFECTIVE merged list, and taking the object rather than a bare array
 * stops the wrong `string[]` being passed by mistake. Unset flags stay absent.
 */
export const buildCaptureSettings = (
  flags: CaptureFlags,
  diagnostics: Pick<CaptureDiagnostics, 'excludedDomains'>,
  verb: CaptureVerb,
): ProfileCaptureSettings | undefined => {
  const settings: ProfileCaptureSettings = {
    ...withKey('browser', safeScalar('browser', flags.browser)),
    ...withKey('profile', safeScalar('profile', flags.profile)),
    // Record `[]` only when the user opted out. An empty list from an empty config is
    // "unknown", not an instruction — storing it would make a later flagless refresh
    // suppress exclusions the user configured after this upload.
    ...withKey(
      'excludeDomains',
      safeDomains(
        'exclude-domain',
        diagnostics.excludedDomains,
        flags.defaultExcludes === false,
      ),
    ),
    ...withKey('onlyDomains', safeDomains('only-domain', flags.onlyDomain)),
    ...withKey('keepDomains', safeDomains('keep-domain', flags.keepDomain)),
    ...(flags.autoFit ? { autoFit: true } : {}),
    ...withKey(
      'passwordStore',
      safeScalar('password-store', flags.passwordStore),
    ),
    cliVersion: version,
  };

  // This run DID filter, so storing the scalars without them would claim otherwise
  // and rebuild a wider capture. Send nothing — its wire meaning is verb-specific.
  if (
    Buffer.byteLength(JSON.stringify(settings), 'utf8') > MAX_SETTINGS_BYTES
  ) {
    warnOverCap(verb);
    return undefined;
  }
  return settings;
};

/**
 * Warned per entry, not once for the whole list: a `.some(usable)` test only catches an
 * ALL-unusable list, so `--exclude-domain bank.example --exclude-domain "$UNSET_VAR"`
 * dropped the unset one in silence and captured the domain the user meant to keep out.
 *
 * Called from `runCapture`, alongside `validateOnlyDomain`, so it fires for `upload` and
 * `inspect` too — `upload` is the verb that CREATES the stored list, and the UI's own
 * `buildUploadCommand` can emit a `*.` that normalizes away. Unlike `--only-domain` this
 * cannot throw: the list is merged with the local config, so an unusable entry must not
 * fail a run the config alone would still have filtered.
 */
export const warnUnusableExcludes = (patterns?: string[]): void => {
  (patterns ?? [])
    .filter((pattern) => normalizeExclusion(pattern) === null)
    .forEach((pattern) => {
      process.stderr.write(
        `  ! --exclude-domain "${terminalSafe(pattern)}" is not a usable domain pattern — nothing was excluded for it\n`,
      );
    });
};

/**
 * Explicit flags win, else the stored value. Lists replace wholesale — appending
 * would make narrowing a stored list impossible.
 */
export const mergeStoredSettings = (
  flags: CaptureFlags,
  stored?: ProfileCaptureSettings | null,
): CaptureFlags => {
  if (!stored) return flags;
  // `--no-default-excludes` clears the stored exclusion list for this run and keeps
  // the local config off. Every other stored member is still inherited below.
  const optedOut = flags.defaultExcludes === false;
  // A list whose every entry normalizes away excludes nothing, so treating it as
  // "the user supplied a list" both skipped the replay and erased the stored one —
  // `--exclude-domain "$UNSET_VAR"` yields `['']`. `--only-domain` has
  // `validateOnlyDomain` for this; `--exclude-domain` is merged, so it cannot throw.
  const hasExplicitExcludes = (flags.excludeDomain ?? []).some(
    (pattern) => normalizeExclusion(pattern) !== null,
  );
  // Presence, not length: a stored `[]` means "captured with no exclusions", so the
  // local config must stay off. Testing `.length` re-applied it and dropped auth
  // state the original capture deliberately kept.
  const replaying = !hasExplicitExcludes && stored.excludeDomains !== undefined;
  return {
    ...flags,
    browser: flags.browser ?? stored.browser,
    profile: flags.profile ?? stored.profile,
    passwordStore: flags.passwordStore ?? stored.passwordStore,
    excludeDomain: hasExplicitExcludes
      ? flags.excludeDomain
      : optedOut
        ? []
        : stored.excludeDomains,
    onlyDomain: flags.onlyDomain ?? stored.onlyDomains,
    keepDomain: flags.keepDomain ?? stored.keepDomains,
    autoFit: flags.autoFit ?? stored.autoFit,
    // A stored list is already the merged list; layering the config on again
    // would double-apply it.
    defaultExcludes: replaying ? false : flags.defaultExcludes,
  };
};

/**
 * A flagless command hides the settings, so print them — and flag `--only-domain`,
 * which discards every credential outside it.
 */
export const printEffectiveSettings = (
  flags: CaptureFlags,
  stored?: ProfileCaptureSettings | null,
  /**
   * Whether the USER passed `--no-default-excludes`, read from argv before the merge.
   * Not inferable from `flags`: `mergeStoredSettings` also sets `defaultExcludes: false`
   * when replaying a stored list, so the post-merge flag conflates "the user opted out"
   * with "we are replaying". Inferring it made the two-flag case
   * (`--no-default-excludes --exclude-domain x`) print that this machine's config applied
   * when it had in fact been suppressed.
   */
  opts: { userOptedOut?: boolean } = {},
): void => {
  if (!stored) return;
  const w = (line: string) => process.stderr.write(`${terminalSafe(line)}\n`);
  // Read from argv, not from the merged flags — see the parameter doc.
  const configOff = opts.userOptedOut === true;
  w('> Refreshing with these effective settings:');
  if (flags.browser) w(`    --browser ${flags.browser}`);
  if (flags.profile) w(`    --profile ${flags.profile}`);
  // Only the entries that survive normalization. `mergeStoredSettings` keeps the list
  // verbatim (an all-unusable list must stay distinguishable from a usable one), so an
  // unset shell var printed as a dangling comma and inflated what the run would exclude.
  const usableExcludes = (flags.excludeDomain ?? []).filter(
    (pattern) => normalizeExclusion(pattern) !== null,
  );
  if (usableExcludes.length) {
    w(`    --exclude-domain ${usableExcludes.join(', ')}`);
  }
  if (flags.onlyDomain?.length) {
    w(`    --only-domain ${flags.onlyDomain.join(', ')}`);
    w('      ! only these domains are captured — everything else in the saved');
    w('        profile is replaced, not kept');
  }
  if (flags.keepDomain?.length) {
    w(`    --keep-domain ${flags.keepDomain.join(', ')}`);
  }
  if (flags.autoFit) {
    w('    --auto-fit (only acts if the capture exceeds the 2 MB cap)');
  }
  if (flags.passwordStore) w(`    --password-store ${flags.passwordStore}`);
  // Echoed even though the user typed it: the block is titled "effective settings", and
  // a flag absent from it reads as not in force while it silently suppresses the config.
  if (configOff) w('    --no-default-excludes');

  // Every empty-exclusion case prints nothing above (`[].length` is falsy) while still
  // changing what leaves this machine, so each gets a line here.
  // Three independent facts, kept apart because collapsing any two of them printed a
  // claim the run then contradicted.
  //   configOff       — this machine's `excluded_domains` is suppressed for this run.
  //   nothingExcluded — the effective list is empty, so a `[]` write will follow.
  //   storedCount     — what the profile had, which is what a loss is measured against.
  // Usable count, not raw length: `--no-default-excludes --exclude-domain "$UNSET"`
  // excludes nothing and writes `[]`, so it belongs in the permanent-write branch.
  const nothingExcluded = configOff && !usableExcludes.length;
  const storedCount = stored.excludeDomains?.length;

  if (nothingExcluded && storedCount) {
    w(
      `  ! --no-default-excludes drops the ${storedCount} stored exclusion pattern(s) for this run,`,
    );
    w('    and re-pass --exclude-domain if you want to keep them.');
  }
  if (nothingExcluded) {
    // Qualified on the cap: `buildCaptureSettings` decides the write AFTER the capture
    // and returns undefined when the settings exceed 8 KB, in which case the stored
    // object survives and `warnOverCap` says so. Stating it flatly here was a false
    // alarm of permanent loss on a privacy control.
    w(
      '  ! Unless the settings exceed the 8 KB cap (reported after the capture), the',
    );
    w(
      '    refreshed profile is stored with NO exclusion list, so later flagless refreshes',
    );
    w("    replay 'exclude nothing' and stop applying this machine's config.");
  } else if (configOff) {
    // The two-flag case. The config IS suppressed, so neither the absent-list line nor
    // the "re-applies your config" hint below may print.
    w(
      '  ! --no-default-excludes is in force: ONLY the --exclude-domain patterns above',
    );
    w("    are excluded, and this machine's own config is not applied.");
  } else if (storedCount === undefined) {
    // No stored list and no opt-out, so the merge left `defaultExcludes` alone and the
    // local config is unioned in with no flag at all.
    w("    (no stored exclusion list — this machine's own config applies)");
    w(
      '    This run stores the effective list on the profile, so later flagless refreshes',
    );
    w('    replay that snapshot instead of re-reading this config.');
  }
  // No branch for a stored `[]` without the opt-out: reaching that needs an explicit
  // --exclude-domain, and the run DOES exclude, so the flag line above already says what.

  // Narrow on purpose: no `--no-auto-fit` exists and a repeatable flag cannot yield
  // an empty list, so neither can be turned off by "passing the matching flag".
  w(
    '  Pass --browser, --profile, --password-store or a domain flag to override.',
  );
  if (!configOff) {
    // Not a pure override: an explicit --exclude-domain leaves `defaultExcludes` unset,
    // so `mergeExclusionPatterns` unions this machine's own config back in.
    w(
      storedCount === undefined
        ? "  --exclude-domain adds to this machine's config for this run; there is no stored list to replace."
        : "  --exclude-domain replaces the stored list and re-applies this machine's config.",
    );
    if (storedCount) {
      w('  --no-default-excludes drops the stored list for good.');
    }
  }
};

export interface CaptureSourceSeams extends SourcePickerSeams {
  isInteractive?: boolean;
  loadCandidates?: typeof loadSourceCandidates;
}

export type CaptureRunResult = CaptureResult & {
  source: { browser: string; profile: string };
};

const resolveCaptureSource = async (
  { browser, profile }: CaptureFlags,
  missingSource: 'stored-settings' | 'flags',
  seams?: CaptureSourceSeams,
  exactSource?: Parameters<typeof loadSourceCandidates>[2],
): Promise<DetectedProfile> => {
  if (browser !== undefined && profile !== undefined)
    return resolveProfile(browser, profile, exactSource);
  const interactive =
    seams?.isInteractive ??
    (captureIsInteractive(process.stdin.isTTY, isCi()) &&
      process.stderr.isTTY === true);
  const missing =
    browser === undefined
      ? profile === undefined
        ? '--browser and --profile are'
        : '--browser is'
      : '--profile is';
  const candidates = await (seams?.loadCandidates ?? loadSourceCandidates)(
    browser,
    profile,
    exactSource,
  ).catch((error: unknown) => {
    // Keep the scripted refresh error when discovery has no matching suggestions.
    if (
      !interactive &&
      missingSource === 'stored-settings' &&
      !exactSource &&
      error instanceof UsageError
    )
      return [];
    throw error;
  });
  if (interactive) {
    const [first, ...rest] = candidates;
    if (!first)
      throw new UsageError(
        'No browser profiles were found on this machine. Register a custom browser with `browserless profile sources add`, then run this again.',
        'no-local-profiles',
      );
    return pickSourceProfile([first, ...rest], seams);
  }
  const guidance = candidates.length
    ? [
        '\nBrowser profiles found on this machine:',
        ...candidates.map((p) => {
          const key = terminalSafe(p.browserKey);
          const dir = JSON.stringify(terminalSafe(p.profileDirName));
          const label = `${terminalSafe(p.browserDisplayName)} / ${terminalSafe(p.profileDisplayName)}`;
          // Custom keys are arbitrary text; don't turn shell syntax into suggested commands.
          if (!/^[\p{L}\p{N}_.][\p{L}\p{N}_ .-]*$/u.test(key)) {
            return `  ${label} (${dir}): pass the browser key ${JSON.stringify(key)} with quoting for your shell`;
          }
          return `  --browser ${key.includes(' ') ? JSON.stringify(key) : key} --profile ${dir}   (${label})`;
        }),
      ].join('\n')
    : ' No browser profiles were found on this machine; register one with `browserless profile sources add`.';
  throw new UsageError(
    missingSource === 'stored-settings'
      ? `${missing} required: this profile has no stored capture settings to read them from (it was not created by the CLI, or this server does not return them yet).${guidance}`
      : `${missing} required when the CLI cannot ask (stdin or stderr is not a terminal, or CI is set).${guidance}`,
    missingSource === 'stored-settings'
      ? 'missing-capture-settings'
      : 'missing-required-flag',
  );
};

export const runCapture = async ({
  flags,
  requiresDisclaimer,
  missingSource,
  sourceSeams,
  exactSource,
}: {
  flags: CaptureFlags;
  requiresDisclaimer: boolean;
  missingSource: 'stored-settings' | 'flags';
  sourceSeams?: CaptureSourceSeams;
  exactSource?: Parameters<typeof loadSourceCandidates>[2];
}): Promise<CaptureRunResult> => {
  const detected = await resolveCaptureSource(
    flags,
    missingSource,
    sourceSeams,
    exactSource,
  );

  if (requiresDisclaimer) {
    await ensureTermsAccepted({
      acceptViaFlag: !!flags.acceptTerms,
      ttlDaysOverride:
        flags.termsTtlDays !== undefined
          ? parseNonNegativeInt('--terms-ttl-days', flags.termsTtlDays)
          : undefined,
    });
  }

  const config = await readConfig();
  const merged = mergeExclusionPatterns(
    config.excluded_domains,
    flags.excludeDomain,
    flags.defaultExcludes === false,
  );

  validateOnlyDomain(flags.onlyDomain ?? []);
  warnUnusableExcludes(flags.excludeDomain);

  // Each diagnostic is one line of untrusted text; add only our own line break.
  const w = (line: string) => process.stderr.write(`${terminalSafe(line)}\n`);
  w(
    `> Capturing ${detected.browserDisplayName} / ${detected.profileDisplayName}`,
  );

  const writeLine = (line: string) => {
    w(`  ${line}`);
  };

  const captureOpts: CaptureOptions = {
    profile: detected,
    excludedDomains: merged,
    onlyDomains: flags.onlyDomain ?? [],
    passwordStoreOverride: flags.passwordStore,
    interactive: captureIsInteractive(process.stdin.isTTY, isCi()),
    onProgress: createProgressRenderer(detected, writeLine),
  };

  const result = await captureFromProfile(captureOpts);

  // Origins were already filtered pre-navigation inside the CDP loop.
  // Cookies still need filtering here — Storage.getCookies is one
  // round-trip with no per-origin scoping.
  if (flags.onlyDomain && flags.onlyDomain.length > 0) {
    const only = applyOnlyFilter(result.state, flags.onlyDomain);
    const cookiesKeptBefore = result.state.cookies.length;
    const cookiesDropped = cookiesKeptBefore - only.state.cookies.length;
    // `only.originsDropped` is 0 today — pre-nav skip is the sole
    // origin-drop path — but adding both terms keeps the displayed total
    // honest if a future post-capture origin filter is introduced.
    const originsDroppedTotal =
      result.diagnostics.originCountSkippedByOnlyDomain + only.originsDropped;
    if (cookiesDropped > 0 || originsDroppedTotal > 0) {
      result.state = only.state;
      result.serialized = JSON.stringify(only.state);
      w(
        `  → --only-domain kept ${result.state.cookies.length} cookies / ${result.state.origins.length} origins; dropped ${cookiesDropped} cookies / ${originsDroppedTotal} origins not matching: ${flags.onlyDomain.join(', ')}`,
      );
    }
  }

  const d = result.diagnostics;
  const artifactBytes = Buffer.byteLength(result.serialized, 'utf-8');
  w(
    `> Captured ${d.cookieCountBeforeExclusion} cookies, ${d.originCountBeforeExclusion} origins in ${d.durationMs}ms (artifact: ${formatBytes(artifactBytes)})`,
  );

  if (d.cookieCountExcluded > 0 || d.originCountExcluded > 0) {
    const patterns = d.excludedDomains.length
      ? d.excludedDomains.join(', ')
      : '(none)';
    w(
      `  → Excluded ${d.cookieCountExcluded} cookies / ${d.originCountExcluded} origins matching: ${patterns}`,
    );
  }

  if (result.capHit) {
    w(`  ! Hit the per-capture origin cap — some origins may be missing`);
  }

  if (d.failedOrigins.length > 0) {
    w(
      `  ! ${d.failedOrigins.length} origin(s) failed to capture — their localStorage / IndexedDB is missing from the upload:`,
    );
    for (const f of d.failedOrigins) {
      w(`      - ${f.origin}: ${f.error}`);
    }
  }

  if (result.passwordStoreDefaulted) {
    w(
      `  ! Linux password-store could not be detected — defaulted to "basic". If decryption failed, re-run with --password-store=<your store>`,
    );
  }

  // ---- size / auto-fit pass ----
  // When the artifact is over the server's profile cap, surface the
  // heaviest origins so the user knows what to do next. With --auto-fit
  // we drop them automatically and mutate `result` in place so the
  // upload path uses the trimmed state.
  if (artifactBytes > SERVER_ARTIFACT_CAP_BYTES) {
    const sizes = measureOriginSizes(result.state);
    const TOP_N = 10;
    w(
      `  ! artifact size ${formatBytes(artifactBytes)} exceeds the ${formatBytes(SERVER_ARTIFACT_CAP_BYTES)} server cap — heaviest origins:`,
    );
    for (const { origin, bytes } of sizes.slice(0, TOP_N)) {
      w(`      ${formatBytes(bytes).padStart(10)}  ${origin}`);
    }
    if (sizes.length > TOP_N) {
      w(
        `      … and ${sizes.length - TOP_N} more origins below ${formatBytes(sizes[TOP_N].bytes)}`,
      );
    }

    if (flags.autoFit) {
      const keepPatterns = flags.keepDomain ?? [];
      const trimmed = trimStateToFit(
        result.state,
        SERVER_ARTIFACT_CAP_BYTES,
        keepPatterns,
      );
      if (
        trimmed.dropped.length === 0 &&
        trimmed.finalBytes <= SERVER_ARTIFACT_CAP_BYTES
      ) {
        // Shouldn't happen given we just measured `artifactBytes >` cap,
        // but guard against weirdness so we never claim a no-op trim.
        w(`  ! --auto-fit had nothing to drop — artifact unchanged`);
      } else {
        result.state = trimmed.state;
        result.serialized = trimmed.serialized;
        // Reflect the drops in diagnostics so `--json` consumers see an
        // honest origin count downstream.
        d.failedOrigins = [
          ...d.failedOrigins,
          ...trimmed.dropped.map((origin) => ({
            origin,
            error: 'dropped by --auto-fit to fit under the server cap',
            kind: 'unknown' as const,
          })),
        ];
        if (trimmed.dropped.length > 0) {
          w(
            `  --auto-fit: dropped ${trimmed.dropped.length} origin(s), now ${formatBytes(trimmed.finalBytes)}:`,
          );
          for (const origin of trimmed.dropped) {
            w(`      - ${origin}`);
          }
        }
        if (trimmed.protectedFromDrop.length > 0) {
          w(
            `  --auto-fit: ${trimmed.protectedFromDrop.length} heavy origin(s) protected by --keep-domain:`,
          );
          for (const origin of trimmed.protectedFromDrop) {
            w(`      - ${origin}`);
          }
        }
        if (trimmed.finalBytes > SERVER_ARTIFACT_CAP_BYTES) {
          // Distinguish the two reasons we couldn't reach the cap so the
          // user knows which lever to pull (drop a --keep-domain, or
          // accept that cookies alone are too heavy).
          if (trimmed.protectedFromDrop.length > 0) {
            w(
              `  ! Still ${formatBytes(trimmed.finalBytes)} after the trim — the --keep-domain origins alone exceed the cap. Remove one or more --keep-domain entries, or accept the upload will be rejected.`,
            );
          } else {
            w(
              `  ! Even after dropping every droppable origin the artifact is still over cap. The cookies alone may be too heavy.`,
            );
          }
        }
      }
    } else {
      w(
        `  Re-run with --auto-fit to drop the heaviest origins automatically (combine with --keep-domain <domain> to protect specific sites; or --only-domain <domain> to capture just those), or pass --exclude-domain <host> for each you want removed.`,
      );
    }
  }

  return {
    ...result,
    source: { browser: detected.browserKey, profile: detected.profileDirName },
  };
};
